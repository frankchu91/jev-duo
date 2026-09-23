# jev-duo — reading mode (design addendum)

Date: 2026-09-22
Status: approved for implementation (owner delegated all design decisions)
Extends: `2026-09-20-jev-duo-design.md`, `2026-09-21-generic-sites-design.md`

## 1. Goal

Feed mode filters a stream. Reading mode reads *one document* with you: on a long-form HTML page
or a PDF it highlights the passages that carry the substance (or that answer a question you typed),
dims the filler, and gives you a clickable outline of the highlights. Same fast brain, one call per
passage, no slow brain at all.

The trigger that motivated it: on `https://arxiv.org/html/1706.03762` the generic feed adapter adopts
the 40-entry bibliography as "the feed" (the 70 body paragraphs are spread over 8 sections, at most 6
per section), and the intent "highlight key things about the article" compiles to a single fold rule.
Nothing visible happens. Reading is a different job and gets its own path.

## 2. Principles

- **Explicit, per page.** Reading is an action (a button in the popup), never an always-on judge.
  Nothing is read until you ask; a second click undoes it. No new permissions: `activeTab` +
  `scripting` inject the reader into the current tab; the PDF reader is an extension page.
- **Never hide.** Dimmed passages stay in place at 35% opacity and restore on hover; one button
  restores all of them. Highlights add, never remove.
- **No slow brain.** The questions are a fixed template with the focus text inlined, so a
  TypeSafe-only setup works.
- **Fail open.** A passage whose judgment errors or times out is shown plain; a document is never
  blanked.
- **One pipeline, two sources.** HTML pages and PDFs both reduce to a list of passages; everything
  from the judge to the panel is shared.

## 3. Passages

```ts
// src/core/reading.ts
export interface Passage { id: string; index: number; text: string; page?: number }
export interface DocContext { title: string; lead: string; source: string }
export const MIN_PASSAGE_CHARS = 40;
export const MAX_PASSAGES = 600;
export const JUDGE_TEXT_MAX = 1500;
```

`id = 'rd:' + fnv1a(text.slice(0, 300))` (`src/core/hash.ts`). `index` is the document order.
`title` ≤ 200 chars; `lead` ≤ 600 chars; `source` is the page URL, the PDF URL, or the picked file
name. A document with more than `MAX_PASSAGES` passages keeps the first 600.

## 4. Judging

### 4.1 Questions (`src/core/reading.ts`)

`readingQuestions(focus: string): JevQuestion[]` returns, in this order:

1. `{ id: 'core', type: 'noul', statement: CORE_STATEMENT }` where
   `CORE_STATEMENT = "The passage states a substantive claim, method, finding, or explanation that carries the document's own content, rather than background, related work, acknowledgments, boilerplate, references, navigation, or filler."`
2. only when `focus.trim() !== ''`:
   `{ id: 'focus', type: 'noul', statement: 'The passage contains information that directly addresses the reader\'s question: "' + focus.trim() + '".' }`
3. `{ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS }`
   with `KIND_OPTIONS = ['claim', 'method', 'result', 'background', 'boilerplate']`.

`readingState(ctx: DocContext, passage: Passage): Record<string, unknown>` =
`{ document_title: ctx.title, document_lead: ctx.lead, passage: passage.text.slice(0, JUDGE_TEXT_MAX) }`.

### 4.2 Decision

```ts
export type ReadingVerdictKind = 'highlight' | 'dim' | 'plain';
export interface ReadingVerdict {
  id: string; verdict: ReadingVerdictKind;
  p: number;          // the probability the decision was made on: focus when a focus is set, else core
  core: number; focus?: number; kind?: string; error?: true;
}
export const T_HIGHLIGHT_CORE = 0.7;
export const T_HIGHLIGHT_FOCUS = 0.6;
export const T_DIM = 0.3;
export function decideReading(id: string, answers: JevAnswer[], hasFocus: boolean): ReadingVerdict
```

- `core` = the `core` answer's `p`, 0.5 when missing; `focus` = the `focus` answer's `p` when present;
  `kind` = the `kind` answer's `choice` when present.
- `highlight` when `hasFocus ? focus >= 0.6 : core >= 0.7`;
- else `dim` when `core <= 0.3 && (!hasFocus || focus <= 0.3)`;
- else `plain`.
- The strictness slider does not apply (fixed thresholds, see §13).

### 4.3 Judge (`src/core/reading-judge.ts`)

```ts
export class ReadingJudge {
  constructor(jev: JevProvider, opts?: { concurrency?: number; timeoutMs?: number; cacheSize?: number }); // 6, 10_000, 2000
  judge(ctx: DocContext, focus: string, passages: Passage[], onVerdict?: (v: ReadingVerdict) => void)
    : Promise<{ verdicts: ReadingVerdict[]; usageTokens: number; errors: number; ms: number }>;
}
```

- One `JevRequest` per passage: `state = readingState(ctx, passage)`, `questions =
  readingQuestions(focus)`, `meta.itemId = passage.id` (so the mock provider's fixtures apply).
- Cache: `LruCache` from `src/core/cache.ts`, key = sha256 of `ctx.title + '|' + focus + '|' +
  passage.text` (same hashing helper the evaluator uses). A hit costs no call and no tokens.
- Concurrency 6, per-call timeout 10 s (AbortSignal), no retries. Error or timeout → `{ verdict:
  'plain', p: 0.5, core: 0.5, error: true }`, counted in `errors`.
- `verdicts` come back in passage order; `onVerdict` fires as each resolves.
- `usageTokens` sums `usage.inputTokens` over live calls.

## 5. HTML articles (`src/extension/reading/article.ts`)

```ts
export interface ArticlePassage extends Passage { el: Element }
export interface Article { ctx: DocContext; passages: ArticlePassage[] }
export function extractArticle(doc: Document): Article | undefined
```

1. **Candidates**: every `p` under `body` whose visible text (the generic adapter's `visibleText`
   rules: skip `script/style/noscript/template`, `hidden`, `aria-hidden="true"`, inline
   `display:none`/`visibility:hidden`), whitespace-collapsed, has ≥ 40 chars, and that has no
   ancestor (`closest`) matching `nav, header, footer, aside, form, figure, figcaption, table, pre,
   code, [role="navigation"], [role="complementary"], [contenteditable]`.
2. **Container**: start at `body`; `mass(node)` = total candidate text length inside `node`. While
   the child element with the largest mass holds ≥ 80% of `mass(node)`, descend into it. The node
   where the descent stops is the container. (A blog whose comments hold a quarter of the text keeps
   the common parent; that is by design — the reader is explicit, and comments are readable too.)
3. **Passages**: the candidates inside the container, document order, first 600; ids per §3.
4. **Article** iff `passages.length >= 6` and their total text ≥ 1500 chars; otherwise `undefined`.
5. **Context**: `title` = the first `h1` in the container, else `document.title`, ≤ 200 chars;
   `lead` = `meta[name="description"]` when ≥ 40 chars, else the first passage; ≤ 600 chars;
   `source = location.href`.

On the arXiv HTML of 1706.03762 the bibliography is `li` elements and never enters; the 67 `p.ltx_p`
do.

## 6. PDFs

### 6.1 Text geometry (`src/extension/reading/pdf-text.ts`, pdf.js-free, pure)

```ts
export interface TextItem { str: string; x: number; y: number; size: number; width: number; rotated: boolean }
export interface PageText { page: number; width: number; height: number; items: TextItem[] }
export type Block =
  | { kind: 'heading'; text: string; page: number }
  | { kind: 'passage'; text: string; page: number };
export interface PdfDoc { title: string; blocks: Block[] }
export function pagesToBlocks(pages: PageText[], fallbackTitle: string): PdfDoc
```

Per page, then joined in page order:

1. Drop `rotated` items and items whose `str` is whitespace only.
2. **Lines**: an item joins the current line when `|y − line.y| ≤ 2`; items in a line are sorted by
   `x` and joined with `''` (pdf.js items carry their own spaces), then whitespace-collapsed.
   `line.size` = the size of the item with the most characters; `line.x` = min `x`; `line.right` =
   max `x + width`; `line.y` = the first item's `y`.
3. **Body size** = the size (rounded to 0.5 pt) with the most characters across the whole document.
4. **Running headers/footers**: a line whose normalized text (lowercased, every digit replaced by
   `#`) appears on at least `pages >= 6 ? 3 : max(2, ceil(pages / 2))` pages within 3 pt of the
   same `y` is dropped on every page (a one-page document therefore never has one: a single page
   cannot show a repetition). A line of ≤ 4 chars made only of digits or roman
   numerals is dropped (page numbers).
5. **Columns**: a line is `full` when `right − x ≥ 0.6 × page.width`, else `left` when `x <
   page.width / 2`, else `right`. Walk lines top→bottom (descending `y`); consecutive lines of the
   same class (`full` vs. columnar) form a band; a columnar band emits its `left` lines (top→bottom)
   then its `right` lines.
6. **Blocks**: in that order, start a new block when there is no previous line; the previous line
   was in a different column; the vertical gap `prev.y − line.y > 1.45 × prev.size`; `|line.size −
   prev.size| > 1`; or the line is a heading line (`size ≥ 1.15 × body` and text ≤ 120 chars).
   Joining a line: if the block text ends with `-` and the line starts with a lowercase letter, drop
   the hyphen and join with `''`; else join with `' '`.
7. **Kinds**: a block whose `size ≥ 1.15 × body` and text ≤ 120 chars is a `heading`; any other block
   with ≥ 40 chars is a `passage`; the rest are dropped.
8. **Title**: the page-1 block with the largest size and ≥ 8 chars, else `fallbackTitle` (the
   PDF's metadata title, else the file name).

Passages are capped at 600, and headings at 600 separately: a heading is never judged, so it costs
nothing against the passage budget, but a 300-slide deck is thousands of short big-text blocks and
every one of them would otherwise become an `<h2>` in the reader page.

### 6.2 Loading (`src/extension/reading/pdf-load.ts`)

```ts
export interface PdfjsLike { getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> } }
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }>
```

`getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false })`;
for each page `getTextContent()`; each item with a `transform` maps to `x = transform[4]`,
`y = transform[5]`, `size = hypot(transform[1], transform[3])`, `width = item.width`,
`rotated = |transform[1]| > 0.01 || |transform[2]| > 0.01`; page `width`/`height` from `page.view`.
`metaTitle` from `getMetadata().info.Title` when non-empty. The pdf.js module is injected so the
browser build (`pdfjs-dist/build/pdf.mjs`) and the Node legacy build (`pdfjs-dist/legacy/build/pdf.mjs`,
unit tests) share the code. Verified on this machine: pdf.js 6.3 extracts text in Node 23 with no
canvas; the 15-page sample paper loads in under 40 ms.

### 6.3 Reader page (`src/extension/reader/reader.html`, `reader.ts`, `reader.css`)

Built to `dist/extension/reader.{html,js,css}`; `pdf.worker.mjs` is copied from
`node_modules/pdfjs-dist/build/pdf.worker.min.mjs`; `reader.ts` sets
`GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs')`. The page's `<title>` is
`jev-duo reader`.

- URL: `reader.html?src=<encodeURIComponent(url)>`. Without `src` only the file picker shows.
- Header: the source (URL or file name) as text; `<input id="focus">` prefilled from
  `Settings.focus` (placeholder `What are you looking for? (optional)`); button `Read` (saves the
  input to settings, re-runs); `<span id="status">`; `<input type="file" id="file"
  accept="application/pdf">` labelled `Open a PDF from your computer` (reads `File.arrayBuffer()`).
- When `src` is an arXiv PDF (`host === 'arxiv.org' && pathname.startsWith('/pdf/')`; `<id>` is the
  rest of the pathname exactly as given, minus a trailing `.pdf`), the header adds the line
  `arXiv also publishes an HTML version of most papers: <a href="https://arxiv.org/html/<id>">open it</a>, then click Read this page — HTML gives better paragraphs than a PDF.`
- Loading: `fetch(src)` → `arrayBuffer()`. On a thrown error or a non-2xx status the status reads
  `can't fetch this file from <origin>` and a button `Allow access to <origin>` appears; its click
  handler calls `chrome.permissions.request({ origins: [origin + '/*'] })` and retries when granted
  (`permission declined` otherwise). arXiv serves `access-control-allow-origin: *`, so its PDFs load
  with no permission at all.
- Rendering into `<main id="doc">`: `<h1>` title; per block a `<h2 class="jd-heading">` or a
  `<p class="jd-passage" data-index="i" data-page="n">`; before the first block of every page a
  `<div class="jd-page-mark">p. n</div>`.
- Zero passages: status `no text found in this PDF (scanned pages need OCR, which jev-duo does not do)`.
- Then the shared reader flow (§8) runs with those `<p>` elements as the passages' `el`.

## 7. Popup

A new section directly after **What to hide / keep**:

```html
<section class="jd-section" id="reading">
  <h2>Read this page</h2>
  <input type="text" id="focus" placeholder="What are you looking for? (optional)" />
  <div class="jd-row">
    <button id="read-page" type="button">Read this page</button>
    <button id="read-pdf" type="button" hidden>Read this PDF</button>
    <span id="read-status" class="jd-status"></span>
  </div>
  <p class="jd-hint">Highlights what carries the substance, dims the rest. <a id="open-reader" href="#">Open the PDF reader</a></p>
</section>
```

- `Settings.focus: string` (default `''`), saved 300 ms after the last keystroke via `setSettings`.
- The active tab is resolved as the **This site** section does; with the `?jd-tab=<url>` test hook
  the tab id comes from `chrome.tabs.query({ url })`.
- Button state from the tab URL: not `http(s)` → `read-page` disabled, status `not a web page`;
  PDF-looking (`/\.pdf$/i` on the pathname, or host `arxiv.org` with a pathname starting `/pdf/`) →
  `read-page` hidden and `read-pdf` shown; otherwise `read-page`.
- `read-page` click: `chrome.scripting.executeScript({ target: { tabId }, files: ['read-page.js'] })`.
  The injection result (`results[0].result`) is the script's completion value, one of
  `{ state: 'started', passages: N }`, `{ state: 'stopped' }`, `{ state: 'no-article', passages: N }`;
  the status reads `reading N passages`, `stopped`, or `this page does not look like an article (N
  passages)`; an undefined result reads `reading`. A rejection reads `can't read this tab:
  <message>`, and when the tab's title ends with `.pdf` the `read-pdf` button is shown as well.
- `read-pdf` and `open-reader` clicks: `chrome.tabs.create({ url: chrome.runtime.getURL('reader.html'
  + (src ? '?src=' + encodeURIComponent(src) : '')) })`, `src` = the tab URL for `read-pdf`, none for
  `open-reader`.

## 8. In-page reader

### 8.1 `src/extension/read-page.ts` (IIFE, injected on demand)

- If `globalThis.__jevDuoReader` exists: `destroy()` it, delete it, result `{ state: 'stopped' }`.
- Else `extractArticle(document)`; none → result `{ state: 'no-article', passages: <candidate count> }`,
  no UI.
- Else `mountReader` (§8.2), store the handle on `globalThis.__jevDuoReader`, result
  `{ state: 'started', passages: N }` — set synchronously; judging continues asynchronously: the
  passages go to the background as `readPassages` in batches of 12 in document order, and each
  response's verdicts are applied as they arrive. `usageTokens`/`errors` are summed for `finish`.
- The result is exposed as the script's completion value: the script assigns it to
  `globalThis.__jevDuoReadResult` and the build appends the footer `globalThis.__jevDuoReadResult;`
  to this bundle only (esbuild `footer.js`), so `executeScript` returns it.

### 8.2 `src/extension/reading/reader-ui.ts` (shared by the page and the reader page)

```ts
export interface ReaderHandle {
  apply(v: ReadingVerdict): void;
  setProgress(judged: number, total: number): void;
  finish(summary: { ms: number; usageTokens: number; errors: number }): void;
  destroy(): void;
}
export function mountReader(host: Document, opts: { passages: ArticlePassage[]; focus: string; onClose(): void }): ReaderHandle
```

- Injects `<style id="jd-reader-style">` once (the CSS is a string constant exported as
  `READER_CSS`). Passage classes: `jd-hl` (`box-shadow: inset 3px 0 0 #f2a900 !important;
  background: rgba(242,169,0,.10) !important`), `jd-dim` (`opacity: .35 !important`, `:hover` →
  `1`), `jd-flash` (1.2 s outline pulse). A highlighted passage gets an appended
  `<span class="jd-rtag">` reading `<kind> · <NN>%` (`<NN>%` alone when `kind` is absent). Plain
  passages get nothing.
- Panel: `<div id="jd-reader">` fixed bottom-right (320 px wide, max 50 vh, scrollable list), with an
  open shadow root. Contents: header `jev-duo reader` and a `×` close button; the line
  `focus: <focus>` when set; a progress line `N of M judged`, replaced on `finish` by
  `M passages · S s · ~$C` (`S` one decimal, `C` = `usageTokens × 0.042 / 1e6` to 4 decimals, from
  `JEV_INPUT_USD_PER_MTOK`) plus ` · E errors` when `E > 0`; an `<ol>` of the highlighted passages in
  document order, each `<kind> · <first 80 chars>…` prefixed `p. N · ` when the passage has a page;
  clicking one calls `el.scrollIntoView({ block: 'center', behavior: 'smooth' })` and flashes it;
  buttons `Show all` (removes `jd-dim` from every passage and relabels itself `Dim again`, which
  restores them) and `Close`.
- `destroy()` removes the classes, the tags, the panel and the style element, then calls `onClose`.
  Mounting while a panel exists destroys the old one first.

## 9. Background

- `Settings.focus` (default `''`).
- `Request: { type: 'readPassages'; ctx: DocContext; passages: Passage[] }` →
  `Response: { ok: true; type: 'readPassages'; focus: string; verdicts: ReadingVerdict[]; usageTokens: number; errors: number }`.
  The background applies `settings.focus`; a `ReadingJudge` wraps the same Jev provider the
  `DuoAgent` resolved and is recreated whenever the provider or keys change (its cache goes with it).
  Any sender may call it: it carries no secrets. Reading is not gated by `enabledSites` or
  `genericSites`; the click is the consent.
- No changes to `DuoStats`; the panel shows the reading counts.

## 10. Build and manifest

- `package.json`: **dev** dependency `pdfjs-dist@^6.3.289`. Its own engines are Node ≥ 22.13 while this
  package publishes `engines.node >= 20`, and only the extension build bundles it — the CLI bundle
  never references pdf.js — so it must not be a runtime dependency.
- `scripts/build.mjs`: entries `read-page.ts` (iife → `read-page.js`, with the §8.1 footer) and
  `reader/reader.ts` (esm → `reader.js`); copies `reader/reader.html`, `reader/reader.css`, and
  `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` → `pdf.worker.mjs`.
- `manifest.json`: unchanged. No new permissions; `reader.html` is opened via
  `chrome.runtime.getURL` and is not web-accessible; the worker is loaded from the extension origin,
  which the default extension CSP allows. pdf.js runs with `isEvalSupported: false`.

## 11. Privacy

Reading sends, per passage, the passage text plus the document title and lead (≤ 600 chars) to the
configured Jev provider, and nothing else; no LLM call is made. PDF bytes are fetched by the reader
page from the URL you opened (or read from the file you picked) and never leave the browser. A PDF
host without open CORS needs that origin's host permission, which is requested only when you click
**Allow access**. Reading a page injects the reader into that tab only, under `activeTab`. The focus
text you typed is echoed in `readPassages` replies and shown in the reader panel, whose shadow root is
open (§8.2), so a script on the page being read can read it back; nothing else about you leaves the
browser.

## 12. Tests

Unit (vitest):

- `reading.ts`: `readingQuestions` with and without focus (ids, order, options); `decideReading`
  table — (core .9, no focus) highlight; (core .7) highlight; (core .69) plain; (core .3) dim;
  (core .31) plain; (focus .6, core .2) highlight; (focus .59, core .2) plain (the focus guard
  blocks the dim); (focus .2, core .2) dim; (focus .59, core .5) plain; missing `core` → 0.5 plain;
  `kind` copied; `readingState` truncates at 1500.
- `reading-judge.ts` (mock provider + stubs): cache hit makes no second call; at most 6 in flight;
  timeout → `plain` with `error` and `errors: 1`; verdict order = passage order; `onVerdict` per
  passage; `usageTokens` summed.
- `article.ts` (jsdom): `tests/e2e/fixtures/article.html` (an arXiv-like page: `nav`, `h1`, an
  abstract `p`, 4 sections × 5 `p`, `ul > li` bibliography × 12, `footer`) → 21 passages, none from
  the bibliography, title from `h1`, lead = the abstract; a blog (`article > p` × 8 with a
  `section#comments` × 3 `p`) → 11 passages (container = the common parent); a docs page with 4
  short `p` → `undefined`; an empty app shell → `undefined`; `p` inside `figure`, `nav`, `aria-hidden`
  or `display:none` excluded; the 600 cap.
- `pdf-text.ts` (synthetic `PageText`): gap split; hyphen join (`trans-` + `former` → `transformer`,
  `re-` + `Use` keeps the hyphen); heading by size; running header on 3 pages dropped; page numbers
  dropped; two-column band order (full title, then left column, then right column, then a full-width
  caption below); rotated dropped; title = largest page-1 block.
- `pdf-load.ts` + `pagesToBlocks` on `tests/e2e/fixtures/sample.pdf` with
  `pdfjs-dist/legacy/build/pdf.mjs` in Node: 2 pages, title `Sample Paper`, ≥ 6 passages, the
  running header absent from every passage. The fixture is written by
  `tests/e2e/fixtures/make-sample-pdf.mjs` (a hand-built PDF: 2 pages, Helvetica, an 18 pt title, a
  14 pt heading per page, 10 pt body paragraphs at 14 pt leading with 24 pt paragraph gaps, the
  running header `Sample Paper - draft` at y = 770 on both pages, page numbers at y = 40) and
  committed; the generator is deterministic and rerunnable.
- `reader-ui.ts` (jsdom): classes and tags applied per verdict; the list holds highlighted passages
  only, in order; `Show all` / `Dim again`; `destroy` restores the DOM and removes the style; a
  second `mountReader` replaces the first.
- popup: `focus` persisted (debounced); button states for an http page, a PDF URL, an arXiv `/pdf/`
  URL and a `chrome://` URL; `read-page` calls `executeScript` with the tab id and shows
  `reading N passages`; a rejection shows `can't read this tab: …`.
- background: `readPassages` answers with `settings.focus` and honours `mockFixtures` keyed by
  passage id.

E2E (Playwright, the existing harness):

- `article.html` served by the fixture server; the popup opened as a tab with `?jd-tab=<page url>`;
  click **Read this page** → status `reading 21 passages`; on the page ≥ 1 `.jd-hl` and ≥ 1
  `.jd-dim` (mock fixtures seeded through `Settings.mockFixtures`, keyed by ids computed with the
  same `fnv1a` over the fixture texts); the panel lists exactly the highlighted passages; **Show
  all** → 0 `.jd-dim`; click **Read this page** again → `stopped` and no `.jd-hl`/`#jd-reader` left.
- `sample.pdf` served with `application/pdf`; open `reader.html?src=http://127.0.0.1:4173/sample.pdf`;
  ≥ 6 `.jd-passage`, 2 `.jd-page-mark`, ≥ 1 `.jd-hl`.
- `@live-jev` (skipped without a key): three passages from the sample paper against the real API —
  a method paragraph, the acknowledgments, and, with focus `how is positional information
  represented`, the positional-encoding paragraph: `core(method) > core(acknowledgments)`,
  `focus(positional) > focus(acknowledgments)`, and every `kind` is one of `KIND_OPTIONS`.

## 13. Non-goals

Scanned PDFs (no text layer), `file://` URLs (use the picker), the strictness slider (reading uses
fixed thresholds), reading automatically on page load, figures, math and tables, comment filtering,
DOCX/EPUB, Firefox.
