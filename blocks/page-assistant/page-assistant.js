// page-assistant.js — a reusable, floating "ask this page" chat assistant that
// runs entirely on Chrome's built-in AI (Prompt API `LanguageModel` / Gemini
// Nano, plus the Summarizer, Translator and Language Detector APIs when
// available). No backend, no API key, no model download managed by us. Answers
// are grounded ONLY in the current page's text, which is extracted and handed
// to the on-device model.
//
// DESIGN CONTRACT (why it is safe on an EDS site):
//   * The bubble is only ever rendered when built-in AI is ACTUALLY available on
//     the device. If it is not, nothing is added to the page.
//   * Detection and mounting happen on idle, after the page has loaded, so they
//     never hold up section loading or LCP.
//   * The floating UI is `position: fixed`, so it never causes layout shift.
//   * Nothing the user types ever leaves the device.
//
// TWO WAYS TO USE IT:
//   1. Authored — drop a `page-assistant` block on a page. `decorate(block)`
//      reads its config and mounts the assistant.
//   2. Global — call `autoMountByPath(patterns, config)` from `scripts.js` to
//      show it across many pages that match a URL pattern, with no authoring.

import { readBlockConfig, loadCSS } from '../../scripts/aem.js';

// Singleton guard: only one assistant per page, no matter how many triggers fire
// (an authored block AND a global auto-mount, multiple matching patterns, etc.).
const MOUNT_FLAG = '__pageAssistantMounted';
// Set synchronously by an authored block so the global auto-mount always defers
// to it, even while the authored mount is still waiting for idle time.
const AUTHORED_FLAG = '__pageAssistantAuthored';

const SUMMARY_TYPES = ['tldr', 'key-points', 'teaser', 'headline'];

const DEFAULT_CONFIG = {
  subtext: 'Answers are based on this page. Nothing you type leaves your device.',
  systemPrompt:
    'You are a helpful assistant embedded on a web page. Answer questions and write '
    + 'summaries based ONLY on the page content provided below. Be concise and factual. '
    + 'If the answer is not in the content, say you could not find it on this page. '
    + 'Do not use outside knowledge.',
  maxContextChars: 8000,
  position: 'bottom-right',
  summaryType: 'tldr',
  title: 'Page assistant',
  // Strict by default: only show when the model is readily available. When true,
  // also show when the model is "downloadable" (first use triggers a download).
  showWhenDownloadable: false,
};

// Run a callback once the browser is idle, off the critical path.
function onIdle(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn, { timeout: 3000 });
  } else {
    window.setTimeout(fn, 1200);
  }
}

// ---------------------------------------------------------------------------
// Built-in AI access
// ---------------------------------------------------------------------------

function languageModelApi() {
  return window.LanguageModel || null;
}

function summarizerApi() {
  return window.Summarizer || null;
}

function translatorApi() {
  return window.Translator || null;
}

function languageDetectorApi() {
  return window.LanguageDetector || null;
}

// The page language (e.g. `en` from `<html lang="en-US">`), used as the model's
// expected input/output language. Chrome warns, and may refuse, when it isn't
// declared.
function pageLanguage() {
  return (document.documentElement.lang || 'en').toLowerCase().split('-')[0] || 'en';
}

// Prompt API options declaring the conversation language.
function languageModelOptions(language) {
  return {
    expectedInputs: [{ type: 'text', languages: [language] }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
}

// The model is usable now or after a (possibly in-progress) download.
function isDownloadState(state) {
  return state === 'downloadable' || state === 'downloading';
}

// Async availability probe. Returns { state, language } where state is one of
// 'available' | 'downloadable' | 'downloading' | 'unavailable'. If the page
// language isn't supported by the model, falls back to English.
async function probeAvailability() {
  const lm = languageModelApi();
  if (!lm || typeof lm.availability !== 'function') return { state: 'unavailable' };
  const candidates = [...new Set([pageLanguage(), 'en'])];
  // eslint-disable-next-line no-restricted-syntax
  for (const language of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const state = await lm.availability(languageModelOptions(language));
      if (state && state !== 'unavailable') return { state, language };
    } catch (err) {
      // Try the next language.
    }
  }
  return { state: 'unavailable' };
}

// Should we show the bubble for this availability state?
function shouldRender(state, config) {
  if (state === 'available') return true;
  if (isDownloadState(state)) return !!config.showWhenDownloadable;
  return false;
}

// ---------------------------------------------------------------------------
// Page text extraction — the grounding context. Pulls readable main-content
// text, excluding the assistant's own UI and non-content chrome.
// ---------------------------------------------------------------------------
// Elements that start a new line of text. Decorated blocks often move elements
// around without the whitespace between them, so without these breaks
// `textContent` would glue words from adjacent elements together.
const BLOCK_ELEMENTS = 'address, article, blockquote, dd, div, dl, dt, figcaption, figure, h1, h2, h3, h4, h5, h6, hr, li, ol, p, pre, section, table, td, th, tr, ul, br';

// Cache the full main-content text (static for the life of the page) so we
// clone-and-scan once and just re-slice per call.
let pageTextCache = null;

function extractPageText(maxChars) {
  if (pageTextCache == null) {
    const root = document.querySelector('main') || document.body;
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll('.page-assistant, .page-assistant-root, script, style, noscript, nav, header, footer, aside, form')
      .forEach((node) => node.remove());
    clone.querySelectorAll(BLOCK_ELEMENTS).forEach((node) => node.after('\n'));
    pageTextCache = (clone.textContent || '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n\s*/g, '\n')
      .trim();
  }
  return pageTextCache.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Model session helpers
// ---------------------------------------------------------------------------

// Build the grounding system prompt: the base instructions plus the page text,
// injected ONCE so it isn't resent every turn (which would quickly exhaust the
// small on-device context window as the conversation grows).
function buildSystemPrompt(config) {
  const pageText = extractPageText(config.maxContextChars);
  return `${config.systemPrompt}\n\nPAGE CONTENT:\n${pageText}`;
}

// Shared download-progress monitor for every on-device model `create()` call.
// `loaded` is a 0–1 fraction in current builds (`total` is 1).
function downloadMonitor(ctx) {
  return (m) => {
    m.addEventListener('downloadprogress', (e) => {
      const pct = Math.round((e.loaded / (e.total || 1)) * 100);
      if (ctx.onProgress) ctx.onProgress(pct);
    });
  };
}

function isAbort(err, ctx) {
  return (err && err.name === 'AbortError') || !!(ctx.controller && ctx.controller.signal.aborted);
}

// Wait for a model `create()` while letting the current turn's Stop button end
// the wait. The signal is deliberately NOT passed to `create()` itself: these
// instances outlive the turn, and aborting a create signal destroys the object
// it created.
function untilAborted(promise, ctx) {
  const signal = ctx.controller && ctx.controller.signal;
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Stopped by the user.', 'AbortError'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Lazily create (once) a persistent LanguageModel session seeded with the system
// prompt + page content. The session is kept across turns so the Prompt API
// retains conversation history, enabling coherent follow-up questions.
async function getLanguageSession(config, ctx) {
  if (!ctx.sessionPromise) {
    const pending = languageModelApi().create({
      ...languageModelOptions(ctx.language),
      initialPrompts: [{ role: 'system', content: buildSystemPrompt(config) }],
      monitor: downloadMonitor(ctx),
    });
    ctx.sessionPromise = pending;
    // Don't keep a failed creation around — the next turn retries.
    pending.catch(() => { if (ctx.sessionPromise === pending) ctx.sessionPromise = null; });
  }
  return untilAborted(ctx.sessionPromise, ctx);
}

function resetLanguageSession(ctx) {
  const pending = ctx.sessionPromise;
  ctx.sessionPromise = null;
  if (pending) {
    pending.then((s) => { if (typeof s.destroy === 'function') s.destroy(); }).catch(() => {});
  }
}

// Did the session run out of context window? Deliberately narrow so unrelated
// errors don't trigger a conversation-destroying retry.
function isContextOverflow(err) {
  if (!err) return false;
  if (err.name === 'QuotaExceededError') return true;
  const msg = `${err.name || ''} ${err.message || ''}`.toLowerCase();
  return msg.includes('quota')
    || msg.includes('context window')
    || msg.includes('too large')
    || msg.includes('too long')
    || msg.includes('exceeds');
}

// Consume a streaming AI response. Every API that ships on the `window` globals
// streams deltas (each chunk is new text), so chunks are simply appended.
async function consumeStream(stream, onDelta) {
  let text = '';
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of stream) {
    text += chunk;
    onDelta(text);
  }
  return text;
}

// Stream one turn on the persistent session, so history accumulates and
// follow-up questions stay coherent.
async function streamTurn(session, question, ctx, onDelta) {
  const stream = session.promptStreaming(question, { signal: ctx.controller.signal });
  return consumeStream(stream, onDelta);
}

/**
 * Stream a grounded chat answer on the shared session. The AbortController is
 * owned by the UI via `ctx.controller` so the Stop button can cancel.
 * @param {string} question the user's question
 * @param {object} config normalised assistant config
 * @param {object} ctx assistant runtime context
 * @param {function(string)} onDelta receives the full answer so far
 * @returns {Promise<string>} the complete answer
 */
export async function runChat(question, config, ctx, onDelta) {
  try {
    // Inside the try so an overflow on the first (largest) create is recovered.
    const session = await getLanguageSession(config, ctx);
    return await streamTurn(session, question, ctx, onDelta);
  } catch (err) {
    // Overflow recovery: rebuild a fresh session (grounding intact) and retry once.
    if (isAbort(err, ctx) || !isContextOverflow(err)) throw err;
    resetLanguageSession(ctx);
    const fresh = await getLanguageSession(config, ctx);
    return streamTurn(fresh, question, ctx, onDelta);
  }
}

// Create an on-device helper (summarizer, translator, detector) once per key and
// reuse it, rather than allocating a new model instance on every click.
async function cachedTool(ctx, key, create) {
  if (!ctx.tools.has(key)) {
    const pending = create();
    ctx.tools.set(key, pending);
    // Don't cache failures — let the next use retry.
    pending.catch(() => ctx.tools.delete(key));
  }
  return untilAborted(ctx.tools.get(key), ctx);
}

// Record a turn produced outside the chat session (e.g. by the Summarizer) in
// the session history, so follow-ups like "expand on the second point" work.
async function rememberTurn(config, ctx, prompt, answer) {
  try {
    const session = await getLanguageSession(config, ctx);
    if (typeof session.append === 'function') {
      await session.append([
        { role: 'user', content: prompt },
        { role: 'assistant', content: answer },
      ]);
    }
  } catch (err) {
    // Best effort: the summary is already shown.
  }
}

/**
 * Summarise the page. Prefers the dedicated Summarizer API; falls back to the
 * LanguageModel with a summarise instruction.
 * @param {object} config normalised assistant config
 * @param {object} ctx assistant runtime context
 * @param {function(string)} onDelta receives the full summary so far
 * @returns {Promise<string>} the complete summary
 */
export async function runSummary(config, ctx, onDelta) {
  const pageText = extractPageText(config.maxContextChars);
  const summarizer = summarizerApi();
  const signal = ctx.controller ? ctx.controller.signal : undefined;
  const prompt = 'Summarise this page.';

  if (summarizer) {
    const options = {
      type: config.summaryType,
      format: 'markdown',
      length: 'medium',
      expectedInputLanguages: [ctx.language],
      outputLanguage: ctx.language,
    };
    let text = null;
    try {
      let state = 'available';
      if (typeof summarizer.availability === 'function') {
        state = await summarizer.availability(options);
      }
      // Honour `showWhenDownloadable`: don't trigger a download the site opted
      // out of — fall through to the already-available LanguageModel instead.
      if (state === 'available' || (isDownloadState(state) && config.showWhenDownloadable)) {
        const s = await cachedTool(ctx, `summarizer:${config.summaryType}`, () => summarizer.create({
          ...options,
          monitor: downloadMonitor(ctx),
        }));
        text = typeof s.summarizeStreaming === 'function'
          ? await consumeStream(s.summarizeStreaming(pageText, { signal }), onDelta)
          : await s.summarize(pageText, { signal });
        onDelta(text);
      }
    } catch (err) {
      // A user Stop must stop — not silently start a second generation.
      if (isAbort(err, ctx)) throw err;
      // Otherwise fall through to the LanguageModel path.
    }
    if (text != null) {
      await rememberTurn(config, ctx, prompt, text);
      return text;
    }
  }

  return runChat(`${prompt} Use a few clear sentences.`, config, ctx, onDelta);
}

// ---------------------------------------------------------------------------
// Translation — Translator API + Language Detector API (both on-device). The
// target languages offered in the UI; source is auto-detected. BCP-47 codes.
// ---------------------------------------------------------------------------
const TRANSLATE_LANGUAGES = [
  { code: 'ar', name: 'Arabic' },
  { code: 'bn', name: 'Bengali' },
  { code: 'de', name: 'German' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'hi', name: 'Hindi' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
];

// Detect the language of a string; falls back to the model language when
// detection is unavailable or inconclusive.
async function detectLanguage(text, ctx) {
  const detector = languageDetectorApi();
  if (!detector) return ctx.language;
  try {
    const det = await cachedTool(ctx, 'detector', () => detector.create({ monitor: downloadMonitor(ctx) }));
    const [top] = await det.detect(text);
    const code = top && top.confidence >= 0.5 ? top.detectedLanguage : '';
    return code && code !== 'und' ? code : ctx.language;
  } catch (err) {
    return ctx.language;
  }
}

// Translate the last assistant answer into targetLanguage, streaming the result.
// The language pack may need a one-time download; that is allowed here because
// picking a language is an explicit user request, and progress is shown.
async function runTranslate(targetLanguage, ctx, onDelta) {
  const source = (ctx.lastAnswer || '').trim();
  if (!source) {
    throw new Error('Ask a question or summarise the page first, then translate the answer.');
  }
  const translator = translatorApi();
  if (!translator) throw new Error('Translation is not available in this browser.');

  const sourceLanguage = await detectLanguage(source, ctx);
  if (sourceLanguage === targetLanguage) {
    onDelta(source);
    return source;
  }

  const pair = { sourceLanguage, targetLanguage };
  let availability = 'available';
  if (typeof translator.availability === 'function') {
    availability = await translator.availability(pair);
  }
  if (availability === 'unavailable') {
    throw new Error(`Translation ${sourceLanguage} → ${targetLanguage} isn’t supported on this device.`);
  }

  const signal = ctx.controller ? ctx.controller.signal : undefined;
  const t = await cachedTool(ctx, `translator:${sourceLanguage}:${targetLanguage}`, () => translator.create({
    ...pair,
    monitor: downloadMonitor(ctx),
  }));

  if (typeof t.translateStreaming === 'function') {
    return consumeStream(t.translateStreaming(source, { signal }), onDelta);
  }
  const text = await t.translate(source, { signal });
  onDelta(text);
  return text;
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free, XSS-safe Markdown → HTML renderer for chat answers.
// The model emits Markdown (**bold**, lists, `code`, headings); rendering it
// avoids showing raw `*` / `#` symbols. Everything is HTML-escaped first, and
// links are restricted to http(s) so model output can't inject markup.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sentinels that shield inline code spans from the emphasis/link passes, so
// `a_b_c` or `2**8` isn't mangled into spurious <em>/<strong> tags.
const CODE_OPEN = '\uE000';
const CODE_CLOSE = '\uE001';

// Input is already HTML-escaped by renderMarkdown, so `"`/`'` are entities and
// can't break out of the href attribute below.
function renderInline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (m, code) => {
    codes.push(code);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });
  out = out
    // Bold first, allowing a nested single `*`/`_` (italic) inside.
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Restore code spans last, untouched by emphasis/link processing.
  return out.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (m, i) => `<code>${codes[Number(i)]}</code>`,
  );
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split('\n');
  const html = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      html.push(`<p>${renderInline(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };
  const flushList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeBuf.push(line);
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      return;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (listType && listType !== type) flushList();
      if (!listType) {
        // Models often separate numbered items with blank lines, which closes
        // the list; `start` keeps the numbering continuous across the break.
        const start = ol && Number(ol[1]) !== 1 ? ` start="${Number(ol[1])}"` : '';
        html.push(`<${type}${start}>`);
        listType = type;
      }
      html.push(`<li>${renderInline(ul ? ul[1] : ol[2])}</li>`);
      return;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      return;
    }

    flushList();
    paraBuf.push(line.trim());
  });

  if (inCode) html.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  flushPara();
  flushList();
  return html.join('');
}

// ---------------------------------------------------------------------------
// Action registry — extensible list of one-click actions in the panel. Push to
// it (it is exported) before the assistant mounts and new actions render
// automatically.
// ---------------------------------------------------------------------------
export const ACTIONS = [
  {
    id: 'summarise',
    label: 'Summarise this page',
    run: (config, ctx, onDelta) => runSummary(config, ctx, onDelta),
  },
];

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// Inline, stroke-based SVG icons (currentColor) for a clean, professional look
// with no external icon dependency.
const ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Apply a custom accent colour, if the author set one. Sets the CSS custom
// properties the whole UI is themed from; the hover shade is derived with
// color-mix when not explicitly provided. Values are lightly sanitised (a CSS
// value can't break out of setProperty, but we drop obviously invalid chars).
function applyAccent(root, config) {
  const clean = (v) => (v ? String(v).replace(/[;{}<>]/g, '').trim() : '');
  const accent = clean(config.accent);
  if (!accent) return;
  root.style.setProperty('--pa-accent', accent);
  const hover = clean(config.accentHover);
  root.style.setProperty(
    '--pa-accent-hover',
    hover || `color-mix(in srgb, ${accent} 85%, #000)`,
  );
}

function buildUI(config) {
  const root = el('div', `page-assistant page-assistant-root page-assistant-${config.position}`);
  applyAccent(root, config);

  // Floating bubble button.
  const bubble = el('button', 'page-assistant-bubble');
  bubble.type = 'button';
  bubble.setAttribute('aria-label', `Open ${config.title}`);
  bubble.setAttribute('aria-expanded', 'false');
  bubble.setAttribute('aria-controls', 'page-assistant-panel');
  bubble.innerHTML = `<span class="page-assistant-bubble-icon page-assistant-icon-chat">${ICONS.chat}</span><span class="page-assistant-bubble-icon page-assistant-icon-chevron">${ICONS.chevron}</span>`;

  // Panel.
  const panel = el('div', 'page-assistant-panel');
  panel.id = 'page-assistant-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', config.title);
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-hidden', 'true');

  const header = el('div', 'page-assistant-header');
  const heads = el('div', 'page-assistant-heads');
  const heading = el('h2', 'page-assistant-title', config.title);
  const subtext = el('p', 'page-assistant-subtext', config.subtext);
  heads.append(heading, subtext);
  const headerBtns = el('div', 'page-assistant-header-btns');
  const clearBtn = el('button', 'page-assistant-clear');
  clearBtn.type = 'button';
  clearBtn.title = 'Clear chat';
  clearBtn.setAttribute('aria-label', 'Clear chat');
  clearBtn.innerHTML = ICONS.clear;
  const closeBtn = el('button', 'page-assistant-close');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = ICONS.close;
  headerBtns.append(clearBtn, closeBtn);
  header.append(heads, headerBtns);

  const actionsRow = el('div', 'page-assistant-actions');
  ACTIONS.forEach((action) => {
    const btn = el('button', 'page-assistant-action', action.label);
    btn.type = 'button';
    btn.dataset.actionId = action.id;
    actionsRow.append(btn);
  });

  // Translate control — only when the on-device Translator API is present.
  let translateSelect = null;
  if (translatorApi()) {
    translateSelect = el('select', 'page-assistant-translate');
    translateSelect.setAttribute('aria-label', 'Translate the last answer');
    const placeholder = el('option', null, 'Translate answer to…');
    placeholder.value = '';
    translateSelect.append(placeholder);
    TRANSLATE_LANGUAGES.forEach((lang) => {
      const opt = el('option', null, lang.name);
      opt.value = lang.code;
      translateSelect.append(opt);
    });
    actionsRow.append(translateSelect);
  }

  const transcript = el('div', 'page-assistant-transcript');
  transcript.setAttribute('aria-live', 'polite');

  const form = el('form', 'page-assistant-input-row');
  const input = el('textarea', 'page-assistant-input');
  input.rows = 1;
  input.placeholder = 'Ask a question about this page…';
  input.setAttribute('aria-label', 'Ask a question about this page');
  const send = el('button', 'page-assistant-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send');
  send.innerHTML = ICONS.send;
  form.append(input, send);

  panel.append(header, transcript, actionsRow, form);
  root.append(bubble, panel);

  return {
    root,
    bubble,
    panel,
    transcript,
    form,
    input,
    send,
    closeBtn,
    clearBtn,
    actionsRow,
    translateSelect,
  };
}

// Set message content: assistant answers are rendered as Markdown; user text
// and status/error lines are plain to avoid any surprises.
function setContent(msg, text, markdown) {
  if (markdown) msg.innerHTML = renderMarkdown(text);
  else msg.textContent = text;
}

function addMessage(transcript, role, text, markdown) {
  const msg = el('div', `page-assistant-msg page-assistant-msg-${role}`);
  if (markdown) msg.classList.add('page-assistant-markdown');
  setContent(msg, text, markdown);
  transcript.append(msg);
  transcript.scrollTop = transcript.scrollHeight;
  return msg;
}

function setBusy(ui, busy) {
  ui.root.classList.toggle('page-assistant-busy', busy);
  // Screen readers announce the finished answer once, not every streamed chunk.
  ui.transcript.setAttribute('aria-busy', String(busy));
  // Send stays enabled while streaming and doubles as a Stop control so the user
  // can cancel a slow/stuck generation (see the submit handler).
  ui.send.classList.toggle('page-assistant-send-stop', busy);
  ui.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
  ui.send.innerHTML = busy ? ICONS.stop : ICONS.send;
  ui.clearBtn.disabled = busy;
  ui.actionsRow.querySelectorAll('button, select').forEach((b) => { b.disabled = busy; });
}

// Grow the textarea with its content (up to the CSS max-height).
function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

function wireUI(ui, config, ctx) {
  const isOpen = () => ui.root.classList.contains('page-assistant-open');
  const openPanel = () => {
    ui.root.classList.add('page-assistant-open');
    ui.panel.setAttribute('aria-hidden', 'false');
    ui.bubble.setAttribute('aria-expanded', 'true');
    ui.bubble.setAttribute('aria-label', `Close ${config.title}`);
    ui.input.focus();
  };
  const closePanel = () => {
    ui.root.classList.remove('page-assistant-open');
    ui.panel.setAttribute('aria-hidden', 'true');
    ui.bubble.setAttribute('aria-expanded', 'false');
    ui.bubble.setAttribute('aria-label', `Open ${config.title}`);
    ui.bubble.focus();
  };

  ui.bubble.addEventListener('click', () => {
    if (isOpen()) closePanel();
    else openPanel();
  });
  ui.closeBtn.addEventListener('click', closePanel);
  ui.root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });

  // Clear chat: empty the transcript, forget the last answer, and drop the base
  // session so the next question rebuilds it from a clean slate.
  ui.clearBtn.addEventListener('click', () => {
    if (ctx.busy) return;
    ui.transcript.replaceChildren();
    ctx.lastAnswer = '';
    resetLanguageSession(ctx);
    ui.input.focus();
  });

  // Progress feedback (e.g. one-time model preparation) surfaces as status text.
  ctx.onProgress = (pct) => {
    if (ctx.statusMsg && pct < 100) ctx.statusMsg.textContent = `Preparing on-device AI… ${pct}%`;
  };

  // Follow the stream only while the reader is at the bottom, so scrolling up to
  // re-read an earlier answer isn't yanked away by every new chunk.
  const isNearBottom = () => {
    const t = ui.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 48;
  };

  const runAndStream = async (runner, userLabel, opts = {}) => {
    const { track = true } = opts;
    if (ctx.busy) return;
    ctx.busy = true;
    ctx.controller = new AbortController();
    setBusy(ui, true);
    if (userLabel) addMessage(ui.transcript, 'user', userLabel);
    const msg = addMessage(ui.transcript, 'assistant', '');
    ctx.statusMsg = msg;
    msg.classList.add('page-assistant-status');
    msg.innerHTML = '<span class="page-assistant-typing"><i></i><i></i><i></i></span>';

    const render = (text) => {
      const follow = isNearBottom();
      msg.classList.remove('page-assistant-status');
      msg.classList.add('page-assistant-markdown');
      setContent(msg, text, true);
      if (follow) ui.transcript.scrollTop = ui.transcript.scrollHeight;
    };
    const renderNote = (text, isError) => {
      msg.classList.remove('page-assistant-status', 'page-assistant-markdown');
      msg.classList.toggle('page-assistant-error', !!isError);
      msg.textContent = text;
    };

    // Coalesce renders to at most one per frame — re-rendering the whole answer
    // and forcing a scroll reflow on every chunk is O(n²) and janky.
    let finalText = '';
    let rafId = 0;
    const stopPaint = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } };

    try {
      await runner((text) => {
        finalText = text;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            render(finalText);
          });
        }
      });
      stopPaint();
      if (finalText.trim()) {
        render(finalText);
        if (track) ctx.lastAnswer = finalText;
      } else {
        renderNote('No answer came back. Try rephrasing your question.');
      }
    } catch (err) {
      stopPaint();
      if (isAbort(err, ctx)) {
        // Stopped by the user: keep whatever streamed, else a subtle note.
        if (finalText.trim()) {
          render(finalText);
          if (track) ctx.lastAnswer = finalText;
        } else {
          renderNote('Stopped.');
        }
      } else {
        renderNote(`Sorry — ${(err && err.message) || 'something went wrong.'}`, true);
      }
    } finally {
      ctx.busy = false;
      ctx.statusMsg = null;
      ctx.controller = null;
      setBusy(ui, false);
    }
  };

  ui.actionsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action-id]');
    if (!btn) return;
    const action = ACTIONS.find((a) => a.id === btn.dataset.actionId);
    if (action) runAndStream((onDelta) => action.run(config, ctx, onDelta), action.label);
  });

  // Translate the last answer into the chosen language (source auto-detected).
  if (ui.translateSelect) {
    ui.translateSelect.addEventListener('change', (e) => {
      const targetLanguage = e.target.value;
      if (!targetLanguage) return;
      const lang = TRANSLATE_LANGUAGES.find((l) => l.code === targetLanguage);
      const name = (lang && lang.name) || targetLanguage;
      e.target.value = '';
      runAndStream(
        (onDelta) => runTranslate(targetLanguage, ctx, onDelta),
        `Translate answer → ${name}`,
        { track: false },
      );
    });
  }

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    // While streaming, the send button is a Stop control: cancel the in-flight
    // generation and leave any typed follow-up untouched (don't clear/discard it).
    if (ctx.busy) {
      if (ctx.controller) ctx.controller.abort();
      return;
    }
    const question = ui.input.value.trim();
    if (!question) return;
    ui.input.value = '';
    autosize(ui.input);
    runAndStream((onDelta) => runChat(question, config, ctx, onDelta), question);
  });

  ui.input.addEventListener('input', () => autosize(ui.input));

  // Enter to send, Shift+Enter for newline. Ignored while streaming so a typed
  // follow-up is preserved rather than silently cleared (use Stop to cancel).
  // Also ignored mid-IME-composition, where Enter confirms a candidate.
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (ctx.busy) return;
      ui.form.requestSubmit();
    }
  });
}

// ---------------------------------------------------------------------------
// Mount — shared by authored and global paths. Idempotent.
// ---------------------------------------------------------------------------

// Site-wide base config an integrator may set early (module scope) via
// `window.pageAssistantConfig`. Both authored blocks and the global auto-mount
// inherit it; per-page/per-call fields are layered on top (merge, not replace),
// so an authored block only needs to specify what it wants to change.
function globalBaseConfig() {
  const c = window.pageAssistantConfig;
  return c && typeof c === 'object' ? c : {};
}

// Normalise a partial config object against the defaults.
function normaliseConfig(partial) {
  const cfg = { ...DEFAULT_CONFIG, ...(partial || {}) };
  const keyword = (v) => String(v).trim().toLowerCase().replace(/[\s_]+/g, '-');
  // Tolerate "8,000" and reject nonsensical values (0/negative) via the default.
  const n = parseInt(String(cfg.maxContextChars).replace(/[,\s_]/g, ''), 10);
  cfg.maxContextChars = Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONFIG.maxContextChars;
  cfg.position = keyword(cfg.position) === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  // Accept authored spellings like "Key Points"; unknown types use the default.
  const summaryType = keyword(cfg.summaryType);
  cfg.summaryType = SUMMARY_TYPES.includes(summaryType) ? summaryType : DEFAULT_CONFIG.summaryType;
  if (typeof cfg.showWhenDownloadable === 'string') {
    cfg.showWhenDownloadable = /^(true|yes|on)$/i.test(cfg.showWhenDownloadable.trim());
  }
  return cfg;
}

/**
 * Mount the floating assistant if (and only if) built-in AI is available.
 * Safe to call multiple times — only one assistant is ever created.
 * @param {object} partialConfig optional config overrides
 * @returns {Promise<boolean>} true if mounted, false if skipped
 */
export async function mountAssistant(partialConfig) {
  if (window[MOUNT_FLAG] || !languageModelApi()) return false;

  const config = normaliseConfig(partialConfig);
  const { state, language } = await probeAvailability();
  if (!shouldRender(state, config)) return false;

  // Claim the singleton only once we know we will actually render.
  if (window[MOUNT_FLAG]) return false;
  window[MOUNT_FLAG] = true;

  try {
    await loadCSS(`${window.hlx.codeBasePath}/blocks/page-assistant/page-assistant.css`);
    const ctx = {
      state,
      language,
      busy: false,
      sessionPromise: null,
      tools: new Map(),
    };
    const ui = buildUI(config);
    wireUI(ui, config, ctx);
    document.body.append(ui.root);
    return true;
  } catch (err) {
    // Release the singleton claim on failure so a later trigger can retry.
    window[MOUNT_FLAG] = false;
    return false;
  }
}

// True when an authored `page-assistant` block exists on the page — claimed by
// `decorate`, still pending decoration, or already mounted. The global
// auto-mount uses this to always defer to an authored instance.
function authoredInstanceExists() {
  return !!window[AUTHORED_FLAG]
    || !!document.querySelector('[data-block-name="page-assistant"], .page-assistant-root');
}

// Path matcher: a RegExp is used as-is; a string is an anchored glob (`*`/`?`),
// so `/blog/*` matches `/blog/x` but not `/catalog/blog`, and `/*` matches all.
function pathMatcher(pattern) {
  if (pattern instanceof RegExp) return pattern;
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const glob = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${glob}$`);
}

/**
 * Global helper for scripts.js: mount the assistant on pages whose pathname
 * matches one of the given patterns. Runs on idle so it never touches the
 * critical path. An authored block on the same page always wins.
 * @param {Array<RegExp|string>} patterns regexes, or anchored globs, tested
 *   against location.pathname
 * @param {object} [config] optional config overrides
 */
export function autoMountByPath(patterns, config) {
  try {
    // A 404 served for a matching path has no content worth asking about.
    if (window.isErrorPage) return;
    const list = (patterns || []).map(pathMatcher);
    const path = window.location.pathname;
    if (!list.some((re) => re.test(path))) return;
    // Merge order for global pages: DEFAULT_CONFIG (in normaliseConfig)
    // <- window.pageAssistantConfig <- config passed here.
    const merged = { ...globalBaseConfig(), ...(config || {}) };
    onIdle(() => {
      // An authored block on this page always wins: skip the global mount so its
      // page-specific config takes precedence over the bulk configuration.
      if (window[MOUNT_FLAG] || authoredInstanceExists()) return;
      mountAssistant(merged).catch(() => { /* never break the page */ });
    });
  } catch (err) {
    // Never let the assistant break the page.
  }
}

/**
 * Authored block entry point. Reads config from the block, removes the authored
 * placeholder (the assistant renders as a floating overlay, not inline), and
 * mounts the shared assistant once the page is idle.
 * @param {Element} block the page-assistant block element
 */
export default function decorate(block) {
  window[AUTHORED_FLAG] = true;
  const raw = readBlockConfig(block);
  const str = (v) => (Array.isArray(v) ? v.join('\n') : `${v ?? ''}`).trim();
  const config = {
    subtext: str(raw.subtext) || undefined,
    systemPrompt: str(raw['system-prompt'] || raw.systemprompt) || undefined,
    maxContextChars: str(raw['max-context-chars'] || raw.maxcontextchars) || undefined,
    position: str(raw.position) || undefined,
    summaryType: str(raw['summary-type'] || raw.summarytype) || undefined,
    title: str(raw.title) || undefined,
    accent: str(raw.accent || raw['accent-color'] || raw.accentcolor) || undefined,
    accentHover: str(raw['accent-hover'] || raw.accenthover) || undefined,
    showWhenDownloadable: str(raw['show-when-downloadable'] || raw.showwhendownloadable) || undefined,
  };
  // Drop undefined keys so defaults apply cleanly.
  Object.keys(config).forEach((k) => config[k] === undefined && delete config[k]);

  // Merge order: DEFAULT_CONFIG (in normaliseConfig) <- site-wide base config
  // <- fields set on this authored block. Authored fields override the global
  // base per page; unset fields inherit it (merge, not full replace).
  const merged = { ...globalBaseConfig(), ...config };

  // Remove the placeholder along with its wrapper, and the section too if the
  // block was all it held, so no empty, margined section is left behind.
  const section = block.closest('.section');
  (block.closest('.page-assistant-wrapper') || block).remove();
  if (section && !section.querySelector(':scope > :not(.section-metadata)')) section.remove();

  onIdle(() => mountAssistant(merged).catch(() => { /* never break the page */ }));
}
