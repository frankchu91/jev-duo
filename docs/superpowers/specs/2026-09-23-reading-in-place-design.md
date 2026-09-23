# jev-duo — reading in place (design addendum)

Date: 2026-09-23
Status: approved for implementation (owner delegated all design decisions)
Extends: `2026-09-22-reading-mode-design.md`

## 1. Goal

The first field test of reading mode surfaced three things:

1. The panel read `65 passages · 0.0 s · ~$0.0000 · 65 errors` and nothing said why. Reproduced
   cause: an unpacked install whose service worker had not been reloaded after the update answers
   `readPassages` with `unknown request type`, every batch fails instantly, and the panel shows a
   count instead of the reason. (Through a freshly loaded extension and the real provider the same
   read gives `21 passages · 0.7 s · ~$0.0004`, 0 errors.)
2. Reading a PDF opened a second tab showing a text rendering of the document. The owner wants
   everything to happen on the page they opened.
3. The PDF reader showed extracted text, not the document.

This addendum makes errors carry their reason, makes an update that needs a reload say so before
anything is clicked, and turns the PDF reader into a viewer that replaces the PDF in the same tab,
renders the same pages, and draws the highlights on them.

## 2. Principles

- **Same tab, same document.** Chrome does not let extensions script its built-in PDF viewer (a
  MIME-handler frame no content script can enter), so no extension can draw on it. The closest
  possible thing, and what this does: the reader replaces the viewer *in the tab that showed the
  PDF*, renders the same pages with pdf.js, draws on them, and **Back** returns to the viewer.
- **Errors carry their reason.** Whatever failed last is printed under the summary, in words.
- **Nothing hidden, nothing new.** Dimming on a rendered page is a 65 % white veil (the same 35 %
  visibility as HTML dimming) that lifts on hover; highlights tint and bar the block. No new
  permissions; the manifest is unchanged.

## 3. Errors made visible

### 3.1 Plumbing

- `ReadingJudge.judge(...)` result gains `lastError?: string`: the message of the most recent failed
  call (`err instanceof Error ? err.message : String(err)`, capped at 200 chars); absent when no
  call failed.
- `readPassages` response gains `lastError?: string` (copied from the judge).
- `runReading`'s summary gains `lastError?: string`: the first of, in batch order, a failed batch's
  `res.error`, else a reply's `lastError`. `ReaderHandle.finish(summary)` accepts it.

### 3.2 Panel

When `summary.errors > 0`, `finish` adds a second line `<p class="error">` under the summary line:

- `last error: <lastError>` when present;
- when `lastError` starts with `unknown request type`, the line is instead
  `STALE_BACKGROUND_HINT = 'the extension was updated — reload it at chrome://extensions (↻) and read again'`;
- `errors without a message` when `lastError` is absent.

### 3.3 Build-id handshake (popup)

- `scripts/build.mjs` computes `buildId = new Date().toISOString()` once per build and passes
  `define: { __JD_BUILD__: JSON.stringify(buildId) }` to every extension bundle (not the CLI).
- `src/extension/build-id.ts`:
  `declare const __JD_BUILD__: string | undefined; export const BUILD_ID: string = typeof __JD_BUILD__ === 'string' ? __JD_BUILD__ : 'dev';`
- `getState` response gains `build: string` (the background's `BUILD_ID`).
- Popup: after a successful `getState`, if `state.build !== BUILD_ID` the **Read this page** and
  **Read this PDF** buttons are disabled and `#read-status` reads
  `STALE_POPUP_STATUS = 'reload the extension at chrome://extensions (↻) to finish updating'` in
  the error style; the rest of the popup keeps working. A failed `getState` changes nothing (the
  existing `loadFailed` path). Under vitest both sides are `'dev'`; in the e2e both bundles come
  from one build; so neither ever sees a false alarm.

### 3.4 Live test through the extension

`tests/e2e/reading-live.spec.ts` gains a `@live-jev` test (guards `LIVE=1` and the key, like the
others): seed `providerMode: 'typesafe'` with the key, **Read this page** on `article.html`, expect
`#read-status` = `reading 21 passages`, the panel's `.progress` to match `/^21 passages · /` and not
contain `errors`, and at least one `.jd-hl`.

## 4. PDF in the same tab

- Popup **Read this PDF**: `chrome.tabs.update(tabId, { url: chrome.runtime.getURL('reader.html?src=' + encodeURIComponent(tabUrl)) })`
  replaces the PDF viewer in that tab (no `tabs.create`). Without a tab id the status is the
  existing `can't read this tab: no tab id`. **Open the PDF reader** (no `src`) keeps `tabs.create`,
  since there is nothing to replace.
- The reader header gains `<a id="back" href="#">← Back to the PDF</a>`: click → `history.back()`.
  Shown only when `src` is set and `history.length > 1`; hidden otherwise (a picker-only reader or a
  reader opened in a fresh tab has nothing to go back to).

## 5. The page, rendered

### 5.1 Geometry (`src/extension/reading/pdf-text.ts`, pure)

```ts
export interface Box { x: number; y: number; width: number; height: number } // PDF user space: origin bottom-left, y up, points
export interface PageText { page: number; width: number; height: number; originX: number; originY: number; items: TextItem[] }
export type Block =
  | { kind: 'heading'; text: string; page: number; box: Box }
  | { kind: 'passage'; text: string; page: number; box: Box };
export function toPercentBox(box: Box, page: { width: number; height: number; originX: number; originY: number }): { left: string; top: string; width: string; height: string }
```

- `originX`/`originY` are `page.view[0]`/`page.view[1]` (0 for synthetic pages; a cropped page can
  have a non-zero origin). `loadPages`/`openPdf` fill them in.
- A line's box: `{ x: line.x, y: line.y − 0.25 × line.size, width: line.right − line.x, height: 1.25 × line.size }`
  (baseline `y`; a quarter em of descent below it, one em of ascent above).
- A block's box is the union of its lines' boxes. Headings carry boxes too.
- `toPercentBox`: `left = (box.x − originX) / width × 100`, `top = (originY + height − (box.y + box.height)) / height × 100`,
  `width = box.width / width × 100`, `height = box.height / height × 100`; each clamped to [0, 100]
  and formatted `${v.toFixed(3)}%`.

### 5.2 Loading (`src/extension/reading/pdf-load.ts`)

```ts
export interface PdfAssets { standardFontDataUrl?: string; cMapUrl?: string; cMapPacked?: boolean; wasmUrl?: string }
export interface OpenedPdf {
  pages: PageText[];
  metaTitle?: string;
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number): Promise<void>;
  destroy(): Promise<void>;
}
export async function openPdf(data: ArrayBuffer, pdfjs: PdfjsLike, assets?: PdfAssets): Promise<OpenedPdf>
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }> // = openPdf + destroy in finally; unchanged for its tests
```

`openPdf` passes `{ data, isEvalSupported: false, useSystemFonts: false, ...assets }` to
`getDocument`. `renderPage`: `page = await doc.getPage(n)`; `scale = cssWidth / page width × pixelRatio`;
`viewport = page.getViewport({ scale })`; `canvas.width = Math.ceil(viewport.width)`,
`canvas.height = Math.ceil(viewport.height)`; `await page.render({ canvas, viewport }).promise`
(pdf.js 6 takes the canvas itself). Errors propagate to the caller. `destroy()` destroys the
loading task; the reader calls it before opening the next document.

### 5.3 Reader page (`src/extension/reader/reader.ts`, `reader.css`)

- `<main id="doc">`: a small `<h1>` with the title, then per page
  `<section class="jd-page" data-page="n" style="aspect-ratio: W / H">` containing
  `<div class="jd-page-mark">p. n</div>`, `<canvas class="jd-canvas">` (CSS `width: 100%; height: 100%`),
  and, per passage block on that page, `<div class="jd-block" data-index="i" data-page="n"
  style="left: …; top: …; width: …; height: …">` positioned by `toPercentBox`. Passage indexes
  are document order across pages; the cap is `MAX_PASSAGES` as before.
- The `.jd-block` overlays are the `ArticlePassage.el` handed to `mountReader`, so `READER_CSS`'s
  `jd-hl` (tint plus left bar) works on them unchanged. `reader.css` adds:
  `.jd-page { position: relative }`, `.jd-block { position: absolute; box-sizing: border-box }`,
  `.jd-block.jd-dim { background: #fff !important; opacity: .65 !important }`,
  `.jd-block.jd-dim:hover { opacity: 0 !important }` (both outrank `READER_CSS`'s `.jd-dim` by
  specificity), `.jd-block .jd-rtag { position: absolute; right: 0; top: -1.3em }`, and
  `.jd-block.jd-block-text { background: #fff; overflow: auto; font: 13px/1.4 system-ui; padding: 2px 4px }`.
- **Lazy canvases.** An `IntersectionObserver` (`rootMargin: '150% 0px'`) renders a section's
  canvas when it nears the viewport: `renderPage(n, canvas, section.clientWidth, Math.min(2, devicePixelRatio))`.
  At most 2 renders in flight (a FIFO queue). A rendered canvas whose section is more than 8 pages
  from the nearest visible section is released (`canvas.width = canvas.height = 0`) and re-rendered
  on approach. Overlay positions are percentages, so a window resize needs no recomputation; the
  visible canvases re-render when the section width changes by more than 25 % (a `ResizeObserver`,
  debounced 300 ms).
- **Render failure** (a page's `renderPage` rejects): the section gets class `jd-render-failed`, and
  each of its overlays gets `textContent = block.text` and class `jd-block-text`, so the passage
  stays readable and judgeable without the canvas. The `el` objects never change identity, so the
  running judge is unaffected.
- The observer and renderer are injectable for tests (`wireUp` takes them as optional deps).
- Everything else — focus box, **Read** (re-runs on the same opened document, no re-fetch), file
  picker, arXiv hint, error statuses, zero-passage message, `src` validation — is unchanged; the
  picker path renders the same way. Before opening a new document the previous one is destroyed.
- **Assets.** The build copies `node_modules/pdfjs-dist/{standard_fonts,cmaps,wasm}` to
  `dist/extension/{standard_fonts,cmaps,wasm}` (about 4 MB together; the zip grows accordingly) and
  the reader passes `standardFontDataUrl: chrome.runtime.getURL('standard_fonts/')`,
  `cMapUrl: chrome.runtime.getURL('cmaps/')`, `cMapPacked: true`, `wasmUrl: chrome.runtime.getURL('wasm/')`,
  so the standard 14 fonts render, CJK-encoded text extracts, and JPX/JBIG2 images decode. A missing
  folder fails the build with a one-line message, like the worker.

## 6. Tests

Unit (vitest):

- `pdf-text.ts`: a single line's box; the union over a three-line block; two-column blocks have
  disjoint boxes; headings carry boxes; `toPercentBox` on a 612 × 792 page with origin (0, 0) and
  with origin (10, 20); clamping of a box that pokes past the page.
- `pdf-load.ts`: `openPdf` on `sample.pdf` through the legacy build returns 2 pages with
  `originX/originY` 0 and a working `destroy`; `renderPage` against a fake pdf.js whose
  `getViewport({ scale })` returns `width = 612 × scale`, `height = 792 × scale` and whose `render`
  records its `{ canvas, viewport }` argument: for `cssWidth 800`, `pixelRatio 2` the canvas is
  1600 × 2071 (ceil) and `render` was called once; a rejecting `render` propagates.
- reader page (jsdom): `render` builds sections with `aspect-ratio`, page marks, and overlays with
  the right `data-index`/`data-page` and percent styles; a rejecting injected renderer turns that
  page's overlays into text (`jd-block-text`, text present); an injected fake observer: entering →
  one render, far away (> 8 pages) → released, re-entering → rendered again; at most 2 in flight.
- `run.ts`: `lastError` from a failed batch; from a reply's `lastError` when no batch failed; absent
  when nothing failed.
- `reader-ui.ts`: `finish` with `errors > 0` shows `last error: …`; the stale hint for
  `unknown request type: readPassages`; `errors without a message`; no second line when `errors = 0`.
- popup: a `getState` whose `build` differs disables both buttons and shows `STALE_POPUP_STATUS`;
  an equal `build` leaves them enabled; **Read this PDF** calls `chrome.tabs.update(tabId, { url })`
  with the reader URL and never `tabs.create`; **Open the PDF reader** still calls `tabs.create`.
- `build-id.ts`: `BUILD_ID === 'dev'` under vitest.
- build: `dist/extension/standard_fonts`, `cmaps`, `wasm` exist after `pnpm build` (asserted the way
  the worker copy is).

E2E (`tests/e2e/reading.spec.ts`):

- `sample.pdf` via `?src=`: 2 `.jd-page`, 8 `.jd-block`, the first canvas rendered (`width > 0`
  once its section is in view), at least one `.jd-block.jd-hl`, clicking a panel row scrolls to its
  overlay; `#back` hidden (fresh tab).
- Same-tab flow: open the fixture PDF URL in a tab, open the popup with `?jd-tab=` for it, click
  **Read this PDF**: that tab's URL becomes `chrome-extension://…/reader.html?src=…` (the context's
  page count is unchanged), 8 `.jd-block`, `#back` visible.
- Picker flow unchanged (8 `.jd-block` instead of `.jd-passage`).
- Live: §3.4.

## 7. Docs

README reading-mode section: PDFs now open in the same tab as a rendered copy with the highlights
drawn on the pages, **Back to the PDF** returns to Chrome's viewer, the `last error` line, and the
reload hint after updating an unpacked install (`chrome://extensions` → ↻). Known limits gain: no
text selection on rendered pages.

## 8. Non-goals

Drawing on Chrome's own PDF viewer (impossible for extensions); a text-selection layer on the
rendered pages; printing; automatic takeover of PDF navigations; persisting highlights; ICC color
profiles.
