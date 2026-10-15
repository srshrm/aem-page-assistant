# Page Assistant

A reusable, floating **"ask this page"** chat assistant for AEM Edge Delivery
Services. It runs entirely on **Chrome's built-in AI** (the Prompt API
`LanguageModel` / Gemini Nano, plus the Summarizer, Translator and Language
Detector APIs when available) — no backend, no API key, no model download
managed by the site.

Answers are grounded **only** in the current page's content. **Nothing the user
types ever leaves their device.**

## What it does

- Renders a small chat bubble in the bottom-right corner of the page.
- On click, opens a panel with:
  - a short subtext explaining what it can do,
  - a one-click **Summarise this page** action (extensible — more actions can be
    added),
  - a **Translate answer to…** selector (shown only when the on-device Translator
    API is available) that translates the last answer into another language
    (a missing language pack is downloaded on demand, with progress shown, since
    picking a language is an explicit user request), and
  - a standard chat input + transcript for asking questions about the page.

Chat is **multi-turn**: the assistant keeps the conversation in context, so
follow-up questions ("expand on that", "why?") work naturally. The page text is
injected into the session **once** (not resent every turn) to preserve the small
on-device context window; if a long conversation exhausts it, the session is
rebuilt transparently (page grounding intact, history dropped) and the question
is retried. A page summary is added to the conversation too, so "expand on the
second point" works after **Summarise this page**. **Clear chat** (the trash icon
in the header) resets the conversation at any time.

While an answer streams, the send button becomes **Stop**; stopping keeps
whatever was already generated. **Escape** closes the panel.

Assistant answers are rendered as **formatted Markdown** (bold, lists, headings,
inline code, links) rather than raw `*`/`#` text. Rendering is done by a tiny,
dependency-free, XSS-safe renderer (all model output is HTML-escaped; links are
restricted to `http(s)`).

## Built-in AI APIs used

| Feature            | API                                             |
| ------------------ | ----------------------------------------------- |
| Chat / Q&A         | Prompt API — `window.LanguageModel`             |
| Summarise page     | Summarizer API — `window.Summarizer` (falls back to the Prompt API) |
| Translate answer   | Translator API — `window.Translator`            |
| Detect source lang | Language Detector API — `window.LanguageDetector` (falls back to the page language) |

The page's `<html lang>` is declared to the models as the expected input and
output language (falling back to English when the model doesn't support it), as
Chrome requires for output quality and safety attestation.

Each capability is feature-detected independently, so the assistant degrades
gracefully: if only the Prompt API is present you still get chat + summary; the
Translate control simply does not appear when the Translator API is missing.

## Availability gating (important)

The bubble is **only rendered when Chrome's built-in AI is actually available**
on the device. If it is not, nothing is added to the page — no dead UI, no
console noise. As other browsers ship the same web APIs, the assistant will light
up there automatically.

By default the assistant only shows when the model is *readily available*. Set
`show-when-downloadable` to `true` to also show it when the model would need a
one-time download on first use.

## Performance (Lighthouse-safe)

- No network or compute on the critical path.
- Detection and mounting happen **on idle**, after the page has loaded, and only
  when built-in AI is present. The authored block removes itself (and its
  section, if it held nothing else) immediately, so it never blocks section
  loading or leaves an empty gap.
- The floating UI is `position: fixed`, so it never causes layout shift (no CLS).
- No third-party requests and no bundled model.

## Usage

### 1. Authored (single page)

Add a **Page Assistant** block to a page. All rows are optional:

| Page Assistant       |                                                    |
| -------------------- | -------------------------------------------------- |
| title                | Page assistant                                     |
| subtext              | Ask me anything about this page.                   |
| system-prompt        | (custom grounding prompt)                          |
| max-context-chars    | 8000                                               |
| position             | bottom-right                                       |
| summary-type         | tldr                                               |
| accent               | #7c3aed                                            |
| show-when-downloadable | false                                            |

The authored block element is a placeholder only — the assistant renders as a
floating overlay, so the block position in the document does not matter.

### 2. Global (many pages, no authoring)

Enable the assistant across pages that match a URL pattern by adding an
`ASSISTANT_PATHS` array to `loadDelayed()` in `scripts/scripts.js`. Patterns are
RegExps, or strings treated as anchored globs (`/blog/*` matches `/blog/x` but not
`/catalog/blog/x`; `/*` matches every page):

```js
// scripts/scripts.js — inside loadDelayed()
const ASSISTANT_PATHS = [/^\/blog\//, /^\/docs\//];
if (ASSISTANT_PATHS.length) {
  import('../blocks/page-assistant/page-assistant.js')
    .then(({ autoMountByPath }) => autoMountByPath(ASSISTANT_PATHS));
}
```

You can pass config overrides as a second argument:

```js
autoMountByPath(ASSISTANT_PATHS, { position: 'bottom-left', summaryType: 'key-points' });
```

An authored instance and a global mount on the same page will not double-up — a
singleton guard ensures only one assistant exists per page.

### Site-wide config (shared base)

To share settings across the whole site — so authored blocks and the global
auto-mount all start from the same base — set `window.pageAssistantConfig` early
(module scope) in `scripts/scripts.js`:

```js
// scripts/scripts.js — module scope (runs before any block decorates)
window.pageAssistantConfig = {
  accent: '#7c3aed',
  systemPrompt: '...site-specific grounding...',
};
```

Both paths inherit this base. Per-page/per-call fields are layered on top, so you
only override what differs.

### Precedence: authored always wins, and merges over the base

If a page is covered by the global `ASSISTANT_PATHS` **and** also has an authored
`page-assistant` block, the **authored block wins deterministically**. The global
auto-mount detects an authored instance on the page and skips, so that page uses
the authored block while every other matching page uses the global auto-mount.

Config resolves as a **merge (cascade), not a full replace**, in this order:

```
built-in defaults  →  window.pageAssistantConfig  →  authored block / autoMountByPath override
```

So an authored block only needs to specify the fields it wants to change — every
field it omits inherits the site-wide base (e.g. your brand `accent` and
`systemPrompt` persist even if the block only sets a custom `title`).

## Config reference

| Key                     | Default          | Description                                             |
| ----------------------- | ---------------- | ------------------------------------------------------- |
| `title`                 | `Page assistant` | Panel + bubble label.                                   |
| `subtext`               | *(see code)*     | Small explainer line under the header.                  |
| `systemPrompt`          | *(grounding)*    | System prompt; keeps answers on-page and factual.       |
| `maxContextChars`       | `8000`           | Cap on page text fed to the model (~2000 tokens).       |
| `position`              | `bottom-right`   | `bottom-right` or `bottom-left`.                        |
| `summaryType`           | `tldr`           | Summarizer API type: `tldr`, `key-points`, `teaser` or `headline`. |
| `accent`                | *(theme)*        | Accent colour for the bubble, chips and buttons. Any CSS colour (e.g. `#7c3aed`, `tomato`). Defaults to the theme's `--link-color`. |
| `accentHover`           | *(derived)*      | Optional hover shade; auto-derived from `accent` when omitted. |
| `showWhenDownloadable`  | `false`          | Also show when the model needs a one-time download.     |

## Browser support

Requires a browser exposing Chrome's built-in AI (`window.LanguageModel`, and
optionally `window.Summarizer`, `window.Translator` and `window.LanguageDetector`).
In Chrome this is available on supported desktop devices once the on-device
model has been downloaded. Where the API is absent or the model isn't ready, the
assistant simply does not appear.

## Extending actions

Actions are declarative. `ACTIONS`, `runSummary` and `runChat` are exported, so
you can add one from `scripts/scripts.js` before the assistant mounts:

```js
import('../blocks/page-assistant/page-assistant.js').then(({ ACTIONS, runSummary, runChat }) => {
  ACTIONS.push({
    id: 'key-points',
    label: 'Key points',
    run: (config, ctx, onDelta) => runSummary({ ...config, summaryType: 'key-points' }, ctx, onDelta),
  });
  ACTIONS.push({
    id: 'faq',
    label: 'Suggest questions',
    run: (config, ctx, onDelta) => runChat('List three questions this page answers.', config, ctx, onDelta),
  });
});
```

Each action gets `(config, ctx, onDelta)` and should pass the full text so far
(not just the new chunk) to `onDelta(text)`.
