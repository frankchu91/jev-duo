# Reading in place Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every reading-mode error say why it happened, warn before a stale unpacked install wastes a read, and turn the PDF reader into a viewer that replaces Chrome's PDF in the same tab, renders the same pages with pdf.js and draws the highlights on them.

**Architecture:** Three independent layers. (a) A `lastError` string rides from `ReadingJudge.judge` through the `readPassages` reply and `runReading`'s summary to a second line in the panel, and a build stamp (`src/extension/build-id.ts`, defined by esbuild once per build) rides on `getState` so the popup can refuse to read through a service worker from an older build. (b) `pdf-text.ts` gains geometry — a `Box` per line, unioned per block, projected to percentages by `toPercentBox` — and `pdf-load.ts` gains `openPdf`, which keeps the pdf.js loading task alive so pages can be rendered to canvases (`loadPages` stays as a destroy-in-`finally` wrapper over it). (c) A new `src/extension/reader/pages.ts` builds one `<section class="jd-page">` per page with a canvas and absolutely-positioned `.jd-block` overlays, and lazily renders canvases behind an injectable observer with a 2-deep FIFO queue; the overlays *are* the `ArticlePassage.el` handed to `mountReader`, so every highlight/dim rule already written works on them unchanged.

**Tech Stack:** as the previous plans (TypeScript 5.9 strict ESM, pnpm, vitest 5 + jsdom, Playwright, esbuild 0.28, Manifest V3, `pdfjs-dist@^6.3.289`).

**Spec:** `docs/superpowers/specs/2026-09-23-reading-in-place-design.md` (extends `2026-09-22-reading-mode-design.md`, which extends `2026-09-20-jev-duo-design.md`).

## Decisions

Where the spec is silent, or names something the real code cannot express as written, this is what the plan does and why. Nothing here changes a threshold, a copy string or an exported name the spec fixes.

1. **`render` moves to a new `src/extension/reader/pages.ts` and takes the pages.** §5.3 needs a `<section>` per *page*, with that page's width/height/origin, which `PdfDoc` does not carry — so the signature becomes `render(doc: PdfDoc, pages: PageText[], container: HTMLElement): RenderedDoc` (`{ passages, sections }`). It plus the lazy renderer is ~170 lines of pure DOM; putting them in `reader.ts` (already 300 lines, and the only file that touches `chrome.*`, `fetch` and pdf.js) would make the one testable half hostage to the untestable one. `reader.ts` keeps `NO_TEXT_STATUS`, `NOT_A_PDF_URL_STATUS`, `errMessage`, `parseErrorStatus`, `isFetchableUrl`, `arxivHtmlUrl` and `wireUp`.
2. **`renderPage` reads the unscaled page width from `page.getViewport({ scale: 1 }).width`**, not from `page.view`. §5.2 says "scale = cssWidth / page width × pixelRatio" without saying which; the viewport is the one pdf.js itself renders against (it already accounts for `/Rotate`), and §6's fake pdf.js only implements `getViewport`, so this is also the only reading that test can satisfy.
3. **`destroy()` destroys the loading task, so `PdfjsLike.getDocument` now returns a task type.** §5.2 says "`destroy()` destroys the loading task", but today `getDocument(params): { promise: Promise<PdfDocumentLike> }` throws the task away. It becomes `getDocument(params): PdfLoadingTaskLike` with `{ promise: Promise<PdfDocumentLike>; destroy?(): Promise<void> }`, and the now-unused `PdfDocumentLike.destroy?` is dropped. Both pdf.js builds satisfy this.
4. **`PageText.originX`/`originY` and `Block.box` are required, not optional**, exactly as §5.1 declares them. Two existing test helpers therefore change: `page()` in `tests/unit/extension/pdf-text.test.ts` gains the two origins, and the `PdfDoc` literals in the reader-page tests gain a `box`. Both edits are part of the task that introduces the field.
5. **The build-output assertion is split in two.** §6 lists "dist/extension/{standard_fonts,cmaps,wasm} exist after `pnpm build`" under *unit*, but `pnpm check` runs `pnpm test` **before** `pnpm build`, so a vitest test that reads `dist/` fails on a clean tree. Vitest asserts the three *source* folders exist under `node_modules/pdfjs-dist` and that `scripts/build.mjs` names all three; the e2e — which runs after a guaranteed build (`tests/e2e/server.ts`'s globalSetup) — asserts the three copies exist under `dist/extension` and are non-empty. Together they are the same guarantee, and neither can pass vacuously.
6. **The render-failure fallback preserves any `.jd-rtag` already on the overlay.** §5.3 says `textContent = block.text`, which would wipe a highlight tag `mountReader` had already appended if a canvas failed after judging started. The overlay's existing `.jd-rtag` children are detached before the text is set and re-appended after — same rendered result in the normal (fail-first) case, no lost tag in the race.
7. **The resize re-render covers every page whose canvas currently holds pixels**, not only the strictly-visible ones. §5.3 says "the visible canvases re-render"; a canvas is only ever *drawn* within 8 pages of a visible one (§5.3's release rule), so the two sets differ only by canvases that are about to be scrolled into view — and skipping those would leave them permanently at the old width, since a drawn page is never re-queued.
8. **`.jd-page-mark` and `.jd-canvas` are absolutely positioned inside the section.** §5.3 puts the mark *inside* `<section class="jd-page">` and gives the canvas `width: 100%; height: 100%`; in normal flow the mark would push the canvas out of a box whose height comes from `aspect-ratio`. The spec's two canvas properties are kept verbatim and `position: absolute; inset: 0` is added to both.
9. **`ReadingJudge`'s 200-character cap is a module-private `LAST_ERROR_MAX = 200`** in `reading-judge.ts`, and the panel's copy decision is an exported pure helper `lastErrorLine(lastError: string | undefined): string` in `reader-ui.ts`. §3.1/§3.2 fix the number and the three strings but name no constant for either; the helper is what makes §6's four panel cases testable without a panel.
10. **The panel's second line is `<p class="error">` inside the shadow root**, with `.error:empty { display: none }` in the private `PANEL_CSS` — the same shape as the existing `.meta:empty` rule. §3.2 fixes the element and the class; the sheet it is styled by is unspecified, and `READER_CSS` is the *document-level* sheet, which cannot reach into the shadow root.
11. **`PageRenderer` exposes `rendered(): number[]`.** §6's observer test needs to say which canvases hold pixels ("entering → one render, far away → released, re-entering → rendered again"); reading `canvas.width` alone cannot distinguish "released" from "never drawn", because jsdom gives a fresh `<canvas>` a default width of 300.
12. **The reader's **Read** button re-judges the document that is already open.** §5.3 says "re-runs on the same opened document, no re-fetch"; today `read()` re-parses `bytes.slice(0)` every time. The opened document is held in a module-local `opened: OpenedPdf | undefined`, destroyed and replaced only when new bytes arrive (a `?src=` load, a granted permission, or the file picker).
13. **`#back` ships `hidden` in `reader.html`** and is un-hidden by `wireUp` when `src` is set and `history.length > 1` (§4). The spec's markup has no `hidden`; without it the link would flash on every picker-only reader load before the script runs.
14. **Heading blocks get no overlay.** §5.3 says "per *passage* block on that page" — a heading is already drawn on the canvas and is never judged, so it needs no `.jd-block`. `h2.jd-heading` disappears from the reader, and with it the e2e's `.jd-heading` assertion (§6's e2e list replaces it with `.jd-block`).
15. **"clicking a panel row scrolls to its overlay" is asserted as the flash.** §6's first e2e flow cannot assert a smooth scroll offset reliably in headless Chromium; `mountReader` adds `jd-flash` to the same element in the same click handler, which is the observable half of that behaviour.
16. **The `@live-jev` extension test launches its own extension inside the test body**, after its two `test.skip` guards, so a plain `pnpm test:e2e` never pays for a Chromium launch it will not use. `reading-live.spec.ts` has no `beforeAll` today and gains none.

## Global Constraints

- `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` green after every task; every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as its last line.
- Feed mode is untouched: no adapter, no fixture, no rule/keep/strictness/arbiter behaviour change. Reading still never reads `Settings.strictness` and never adds to `DuoStats`.
- **No new permissions and no manifest change.** `src/extension/manifest.json` is not edited by any task. `reader.html` stays non-web-accessible; the copied pdf.js asset folders are read from the extension's own origin with `chrome.runtime.getURL`, which needs no `web_accessible_resources` entry.
- Copy strings are verbatim from the spec:
  - `STALE_BACKGROUND_HINT = 'the extension was updated — reload it at chrome://extensions (↻) and read again'`
  - `STALE_POPUP_STATUS = 'reload the extension at chrome://extensions (↻) to finish updating'`
  - `last error: <lastError>`, `errors without a message`, `← Back to the PDF`
  - and, unchanged from the previous plan: `Read this page`, `Read this PDF`, `Open the PDF reader`, `reading N passages`, `stopped`, `not a web page`, `can't read this tab: no tab id`, `not a PDF URL`, `no text found in this PDF (scanned pages need OCR, which jev-duo does not do)`, `Open a PDF from your computer`, `jev-duo reader`, `Show all`, `Dim again`, `Close`, `N of M judged`.
- Exact geometry (§5.1): line box `{ x: line.x, y: line.y − 0.25 × line.size, width: line.right − line.x, height: 1.25 × line.size }`; a block's box is the union of its lines'; `toPercentBox` is `left = (box.x − originX) / width × 100`, `top = (originY + height − (box.y + box.height)) / height × 100`, `width = box.width / width × 100`, `height = box.height / height × 100`, each clamped to `[0, 100]` and formatted `${v.toFixed(3)}%`.
- Exact rendering constants (§5.3): `rootMargin: '150% 0px'`, at most **2** renders in flight, release beyond **8** pages from the nearest visible section, re-render on a **25 %** section-width change, `ResizeObserver` debounced **300 ms**, pixel ratio `Math.min(2, devicePixelRatio)`.
- `IntersectionObserver` and `ResizeObserver` do not exist in jsdom: every use is behind an injectable factory whose default is a `typeof`-guarded no-op, so importing the module in a unit test never touches either.
- pdf.js 6 facts to respect: `page.render({ canvas, viewport })` takes the canvas itself; `page.getViewport({ scale })`; `page.view = [x0, y0, x1, y1]`; `getDocument` takes `standardFontDataUrl`, `cMapUrl`, `cMapPacked`, `wasmUrl`; the loading task is destroyed with `loadingTask.destroy()`; `isEvalSupported: false` and `useSystemFonts: false` stay set.
- `chrome.tabs.update(tabId, { url })` needs no extra permission for the extension's own page. It replaces `tabs.create` for **Read this PDF** only; **Open the PDF reader** keeps `tabs.create`.
- Fail open everywhere: a passage whose judgment errors is still shown, a page whose canvas fails still shows its text, a document is never blanked.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/core/reading-judge.ts` | `ReadingRun.lastError` (most recent failed call, capped at 200) | 1 |
| `src/extension/build-id.ts` | **new** — `BUILD_ID`, `'dev'` unless esbuild defined `__JD_BUILD__` | 1 |
| `src/extension/messages.ts` | `readPassages`'s `lastError`, `getState`'s `build` | 1 |
| `src/extension/background.ts` | copies `lastError` through, answers `build` | 1 |
| `src/extension/reading/run.ts` | the summary's `lastError` (first in batch order) | 1 |
| `src/extension/reading/reader-ui.ts` | `STALE_BACKGROUND_HINT`, `lastErrorLine`, the panel's second line | 1 |
| `src/extension/popup/popup.ts` | `STALE_POPUP_STATUS` + stale detection (T1); same-tab **Read this PDF** (T3) | 1, 3 |
| `scripts/build.mjs` | `define: { __JD_BUILD__ }` (T1); the three pdf.js asset copies (T2) | 1, 2 |
| `src/extension/reading/pdf-text.ts` | `Box`, `PageText` origins, block boxes, `toPercentBox` | 2 |
| `src/extension/reading/pdf-load.ts` | `PdfAssets`, `OpenedPdf`, `openPdf`, `renderPage`; `loadPages` as a wrapper | 2 |
| `src/extension/reader/pages.ts` | **new** — `render` (sections, canvases, overlays) and `mountPageRenderer` | 3 |
| `src/extension/reader/reader.ts` | opens once, renders in place, wires the renderer and `#back` | 3 |
| `src/extension/reader/reader.html` | `<a id="back">` | 3 |
| `src/extension/reader/reader.css` | `.jd-page` / `.jd-canvas` / `.jd-block` rules | 3 |
| `tests/unit/extension/chrome-stub.ts` | `chrome.tabs.update` + `updatedTabs()` | 3 |
| `tests/unit/extension/build-id.test.ts` | **new** — `BUILD_ID === 'dev'` under vitest | 1 |
| `tests/unit/extension/reader-pages.test.ts` | **new** — `render`, the failure fallback, the fake observer | 3 |
| `tests/unit/core/reading-judge.test.ts` | `lastError` cases | 1 |
| `tests/unit/extension/{reader-ui,popup,background,pdf-text,pdf-load,reader-page}.test.ts` | the rest of §6's unit list | 1, 2, 3 |
| `tests/e2e/reading.spec.ts` | the three §6 flows + the asset assertion | 2, 3 |
| `tests/e2e/reading-live.spec.ts` | the `@live-jev` extension test | 1 |
| `README.md` | the reading-mode section and Known limits | 3 |

---

### Task 1: Errors made visible and the build-id handshake

Implements spec §3 in full (§3.1 plumbing, §3.2 panel, §3.3 build-id handshake, §3.4 live test).

**Files:**
- Create: `src/extension/build-id.ts`, `tests/unit/extension/build-id.test.ts`
- Modify: `src/core/reading-judge.ts`, `src/extension/messages.ts`, `src/extension/background.ts`, `src/extension/reading/run.ts`, `src/extension/reading/reader-ui.ts`, `src/extension/popup/popup.ts`, `scripts/build.mjs`
- Test: `tests/unit/core/reading-judge.test.ts`, `tests/unit/extension/reader-ui.test.ts`, `tests/unit/extension/popup.test.ts`, `tests/unit/extension/background.test.ts`, `tests/e2e/reading-live.spec.ts`

**Interfaces:**
- Consumes: nothing from a later task. From the existing code: `ReadingJudge.judge(ctx, focus, passages, onVerdict?): Promise<ReadingRun>`; `runReading(deps): Promise<{ ms, usageTokens, errors }>`; `ReaderHandle.finish(summary)`; `initPopup(doc, { send, activeTabUrl? })`.
- Produces, for Tasks 2 and 3:
  - `src/extension/build-id.ts` → `export const BUILD_ID: string` (`'dev'` under vitest and any unbundled import).
  - `src/core/reading-judge.ts` → `ReadingRun` gains `lastError?: string`.
  - `src/extension/messages.ts` → the `readPassages` response gains `lastError?: string`; the `getState` response gains `build: string` (every test double that builds a `getState` response must now set it).
  - `src/extension/reading/run.ts` → `runReading(deps): Promise<{ ms: number; usageTokens: number; errors: number; lastError?: string }>`.
  - `src/extension/reading/reader-ui.ts` → `export const STALE_BACKGROUND_HINT: string`; `export function lastErrorLine(lastError: string | undefined): string`; `ReaderHandle.finish(summary: { ms: number; usageTokens: number; errors: number; lastError?: string }): void`.
  - `src/extension/popup/popup.ts` → `export const STALE_POPUP_STATUS: string`.

- [ ] **Step 1: Write the failing `ReadingJudge.lastError` tests**

Append to the `describe('ReadingJudge', ...)` block in `tests/unit/core/reading-judge.test.ts`:

```ts
  // --- Design addendum 2026-09-23 §3.1: an error that says nothing is a bug report nobody can file ---

  it('reports the most recent failed call as lastError, capped at 200 characters', async () => {
    const jev: JevProvider = {
      name: 'failing',
      async evaluate(): Promise<JevResponse> {
        throw new Error(`upstream said no: ${'x'.repeat(300)}`);
      },
    };

    const run = await new ReadingJudge(jev).judge(CTX, '', passages('a passage whose call fails'));

    expect(run.errors).toBe(1);
    expect(run.lastError).toHaveLength(200);
    expect(run.lastError?.startsWith('upstream said no: xxx')).toBe(true);
  });

  it('reports a timeout by its own message', async () => {
    const jev: JevProvider = { name: 'slow', evaluate: () => new Promise<JevResponse>(() => {}) };

    const run = await new ReadingJudge(jev, { timeoutMs: 5 }).judge(CTX, '', passages('a passage nobody answers'));

    expect(run.lastError).toBe('timeout after 5ms');
  });

  it('leaves lastError absent when every call succeeded', async () => {
    const run = await new ReadingJudge(stubJev()).judge(CTX, '', passages('first passage', 'second passage'));

    expect(run.errors).toBe(0);
    expect(run.lastError).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/core/reading-judge.test.ts`
Expected: FAIL — `Property 'lastError' does not exist on type 'ReadingRun'` (and, at runtime, `expected undefined to have length 200`).

- [ ] **Step 3: Carry the last failure out of the judge**

In `src/core/reading-judge.ts`, add the cap constant under `READING_CACHE_SIZE`:

```ts
/** §3.1. The panel prints this under the summary line, so it has to fit on one: a provider that
 * answers a failure with a whole HTML page would otherwise push the panel off the screen. */
const LAST_ERROR_MAX = 200;
```

Add the field to `ReadingRun`:

```ts
export interface ReadingRun {
  verdicts: ReadingVerdict[];
  usageTokens: number;
  errors: number;
  ms: number;
  /** The message of the most recent call that failed (§3.1); absent when none did. */
  lastError?: string;
}
```

In `judge`, declare it next to the other counters:

```ts
    let usageTokens = 0;
    let errors = 0;
    let lastError: string | undefined;
```

Record it in the existing `catch` (the rest of the block is unchanged):

```ts
        } catch (err) {
          // Fail open (§2): the passage is shown exactly as the document rendered it. Never cached —
          // a transient failure must not pin a passage to "plain" for the rest of the session. Counted
          // once per passage, not once per call: `errors` is what the panel's "N errors" line sits
          // next to "M passages", and every one of these passages did go unjudged.
          errors += at.length;
          // §3.1: the LAST failure wins. Ten passages failing the same way all carry the same message,
          // and when they do not, the most recent one is the one the reader can still act on.
          lastError = (err instanceof Error ? err.message : String(err)).slice(0, LAST_ERROR_MAX);
          fanOut(at, { id: passage.id, verdict: 'plain', p: 0.5, core: 0.5, error: true });
        } finally {
```

And return it:

```ts
    return { verdicts, usageTokens, errors, lastError, ms: Date.now() - started };
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `pnpm vitest run tests/unit/core/reading-judge.test.ts`
Expected: PASS (all existing cases plus the three new ones).

- [ ] **Step 5: Write the failing `runReading` summary tests**

Append inside the existing `describe('runReading', ...)` block in `tests/unit/extension/reader-ui.test.ts`:

```ts
  // --- Design addendum 2026-09-23 §3.1: the summary carries the reason, not just the count ---

  it("carries a failed batch's error into the summary", async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const send = sendSpy(() => ({ ok: false, error: 'unknown request type: readPassages' })).send;

    const summary = await runReading({ handle, ctx, passages, send });

    expect(summary.errors).toBe(5);
    expect(summary.lastError).toBe('unknown request type: readPassages');
  });

  it('keeps the FIRST error in batch order, not the last', async () => {
    const { doc, passages } = docWith(4);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    let n = 0;
    const send = sendSpy(() => {
      n += 1;
      return { ok: false, error: `batch ${n} failed` };
    }).send;

    const summary = await runReading({ handle, ctx, passages, send, batchSize: 2 });

    expect(summary.lastError).toBe('batch 1 failed');
  });

  it("carries a reply's own lastError when no batch failed outright", async () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const send = sendSpy((req) =>
      req.type === 'readPassages'
        ? { ok: true, type: 'readPassages', focus: '', verdicts: [], usageTokens: 0, errors: 1, lastError: 'invalid api key' }
        : undefined,
    ).send;

    const summary = await runReading({ handle, ctx, passages, send });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toBe('invalid api key');
  });

  it('leaves lastError absent when nothing failed at all', async () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    const summary = await runReading({ handle, ctx, passages, send: sendSpy().send });

    expect(summary.errors).toBe(0);
    expect(summary.lastError).toBeUndefined();
  });
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'lastError' does not exist in type ...` on the `readPassages` reply, and `expected undefined to be 'unknown request type: readPassages'`.

- [ ] **Step 7: Add `lastError` to the message contract and to `runReading`**

In `src/extension/messages.ts`, extend the `readPassages` response (the doc comment above it is unchanged):

```ts
  // `focus` is the setting the background actually applied, echoed so the reader panel can show the
  // question the verdicts answer without reading Settings itself (a content script may not).
  // `lastError` is the judge's most recent failed call (§3.1), so "65 errors" can say why.
  | { ok: true; type: 'readPassages'; focus: string; verdicts: ReadingVerdict[]; usageTokens: number; errors: number; lastError?: string }
```

In `src/extension/reading/run.ts`, widen the return type and thread the value through:

```ts
export async function runReading(deps: {
  handle: ReaderHandle;
  ctx: DocContext;
  passages: Passage[];
  send: typeof send;
  batchSize?: number;
  now?: () => number;
}): Promise<{ ms: number; usageTokens: number; errors: number; lastError?: string }> {
```

Declare it beside the counters:

```ts
  let errors = 0;
  // §3.1: the FIRST reason in batch order, not the last — the first batch to fail is the one that
  // explains the run (a stale service worker answers every later batch identically anyway).
  let lastError: string | undefined;
```

Record it in both arms of the existing branch:

```ts
    if (res.ok && res.type === 'readPassages') {
      if (!focusShown) {
        handle.setFocus(res.focus);
        focusShown = true;
      }
      for (const verdict of res.verdicts) handle.apply(verdict);
      usageTokens += res.usageTokens;
      errors += res.errors;
      if (lastError === undefined && res.lastError !== undefined) lastError = res.lastError;
    } else {
      // Fail open (§2): a batch the background could not answer leaves its passages exactly as the
      // document rendered them, counted so the summary line admits it.
      errors += batch.length;
      // `!res.ok` is what narrows `res` to the error variant — the ok variant always has this type.
      if (lastError === undefined && !res.ok) lastError = res.error;
    }
```

And build the summary with it:

```ts
  const summary = { ms: now() - started, usageTokens, errors, lastError };
```

In `src/extension/reading/reader-ui.ts`, widen `ReaderHandle.finish`:

```ts
  finish(summary: { ms: number; usageTokens: number; errors: number; lastError?: string }): void;
```

In `src/extension/background.ts`, copy it into the reply inside `handleReadPassages`:

```ts
    const { verdicts, usageTokens, errors, lastError } = await readingJudge.judge(ctx, focus, passages.slice(0, MAX_PASSAGES));
    return { ok: true, type: 'readPassages', focus, verdicts, usageTokens, errors, lastError };
```

- [ ] **Step 8: Run both suites to make sure they pass**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts tests/unit/core/reading-judge.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing background test for the copied `lastError`**

Append inside `describe('readPassages', ...)` in `tests/unit/extension/background.test.ts`:

```ts
    // §3.1: the reason has to survive the port. A 401 is not retryable, so this resolves immediately
    // rather than spending the http layer's two backoff sleeps.
    it("copies the judge's lastError into the reply", async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'typesafe', keys: { typesafe: 'ts-key' } } });
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const bg = createBackground({ fetchImpl });
      await bg.ready;

      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'some text')] });

      if (!res.ok || res.type !== 'readPassages') throw new Error('expected a readPassages response');
      expect(res.errors).toBe(1);
      expect(res.lastError).toBe('invalid api key');
      expect(res.verdicts[0]).toMatchObject({ verdict: 'plain', error: true });
    });
```

- [ ] **Step 10: Run it to make sure it passes**

Run: `pnpm vitest run tests/unit/extension/background.test.ts -t 'copies the judge'`
Expected: PASS — Step 7 already added the copy; this locks it in (if it fails, the copy in `handleReadPassages` is missing).

- [ ] **Step 11: Write the failing panel tests for the second line**

Add `lastErrorLine` and `STALE_BACKGROUND_HINT` to the `reader-ui` import at the top of `tests/unit/extension/reader-ui.test.ts`:

```ts
import { lastErrorLine, mountReader, READER_CSS, STALE_BACKGROUND_HINT } from '../../../src/extension/reading/reader-ui';
```

Append a new top-level `describe` after `describe('mountReader panel', ...)`:

```ts
describe('the panel says why it failed (§3.2)', () => {
  const errorLineOf = (doc: Document): string | null => panelOf(doc).querySelector('p.error')?.textContent ?? null;

  it('prints the last error under the summary', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({
      ms: 1000,
      usageTokens: 0,
      errors: 2,
      lastError: 'invalid api key',
    });

    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('2 passages · 1.0 s · ~$0.0000 · 2 errors');
    expect(errorLineOf(doc)).toBe('last error: invalid api key');
  });

  it('turns a stale service worker into the reload hint instead', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({
      ms: 1000,
      usageTokens: 0,
      errors: 2,
      lastError: 'unknown request type: readPassages',
    });

    expect(errorLineOf(doc)).toBe(STALE_BACKGROUND_HINT);
    expect(STALE_BACKGROUND_HINT).toBe('the extension was updated — reload it at chrome://extensions (↻) and read again');
  });

  it('admits when the errors carried no message at all', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 2 });

    expect(errorLineOf(doc)).toBe('errors without a message');
  });

  it('adds no second line when nothing failed', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 0 });

    expect(errorLineOf(doc)).toBe('');
  });

  it('lastErrorLine is the whole decision, and is pure', () => {
    expect(lastErrorLine(undefined)).toBe('errors without a message');
    expect(lastErrorLine('HTTP 502')).toBe('last error: HTTP 502');
    expect(lastErrorLine('unknown request type: readPassages')).toBe(STALE_BACKGROUND_HINT);
    expect(lastErrorLine('unknown request type')).toBe(STALE_BACKGROUND_HINT);
    // Not a prefix match: a message that merely mentions it is still printed verbatim.
    expect(lastErrorLine('the background replied unknown request type')).toBe('last error: the background replied unknown request type');
  });
});
```

- [ ] **Step 12: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts`
Expected: FAIL — `has no exported member 'lastErrorLine'` / `'STALE_BACKGROUND_HINT'`.

- [ ] **Step 13: Add the hint, the helper and the line to `reader-ui.ts`**

In `src/extension/reading/reader-ui.ts`, export the two new pure pieces just under `READER_CSS`:

```ts
/** §3.2. What `background.ts`'s dispatch default answers is `unknown request type: <type>`, which is
 * exactly what an unpacked install whose service worker predates the update says to every single
 * `readPassages` — 65 instant failures and a count that explains nothing. This says what to do. */
export const STALE_BACKGROUND_HINT = 'the extension was updated — reload it at chrome://extensions (↻) and read again';

/** §3.2's whole decision, as one pure function: the reason when there is one, the hint when the reason
 * is the stale-worker one, and an admission when the failures carried no message. */
export function lastErrorLine(lastError: string | undefined): string {
  if (lastError === undefined) return 'errors without a message';
  if (lastError.startsWith('unknown request type')) return STALE_BACKGROUND_HINT;
  return `last error: ${lastError}`;
}
```

In `PANEL_CSS`, add the error rules after the `.meta:empty` rule:

```
.error { color: #b3261e; margin: 0; padding: 0 10px 4px; }
.error:empty { display: none; }
```

and inside the `@media (prefers-color-scheme: dark)` block, after `.meta { color: #a4a4ac; }`:

```
  .error { color: #ff6b6b; }
```

Create the element next to `progressLine` in `mountReader`:

```ts
  const progressLine = host.createElement('p');
  progressLine.className = 'meta progress';
  // §3.2's second line. Empty (and `display: none` by the sheet above) until `finish` has something
  // to say — it is never shown while a read is still running, only under the final summary.
  const errorLine = host.createElement('p');
  errorLine.className = 'error';
  const list = host.createElement('ol');
```

Include it in the panel:

```ts
  wrap.append(head, focusLine, progressLine, errorLine, list, foot);
```

And fill it in `finish`:

```ts
    finish(summary): void {
      if (destroyed) return;
      const usd = ((summary.usageTokens * JEV_INPUT_USD_PER_MTOK) / 1e6).toFixed(4);
      const errors = summary.errors > 0 ? ` · ${summary.errors} errors` : '';
      progressLine.textContent = `${opts.passages.length} passages · ${(summary.ms / 1000).toFixed(1)} s · ~$${usd}${errors}`;
      errorLine.textContent = summary.errors > 0 ? lastErrorLine(summary.lastError) : '';
    },
```

- [ ] **Step 14: Run it to make sure it passes**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts`
Expected: PASS.

- [ ] **Step 15: Write the failing `BUILD_ID` test**

Create `tests/unit/extension/build-id.test.ts`:

```ts
// The stamp both extension bundles carry (design addendum §3.3). Nothing defines `__JD_BUILD__` under
// vitest — the define lives in scripts/build.mjs and applies to the esbuild bundles only — so this is
// also the test that the `typeof` guard really is a guard: a bare read of an undeclared identifier
// throws a ReferenceError, and that would take the whole popup down.

import { describe, expect, it } from 'vitest';
import { BUILD_ID } from '../../../src/extension/build-id';

describe('BUILD_ID', () => {
  it("is 'dev' when nothing defined __JD_BUILD__", () => {
    expect(BUILD_ID).toBe('dev');
  });
});
```

- [ ] **Step 16: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/build-id.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/build-id"`.

- [ ] **Step 17: Create `src/extension/build-id.ts`**

```ts
// The build stamp the popup and the service worker compare (design addendum §3.3). esbuild replaces
// `__JD_BUILD__` in every extension bundle with one ISO timestamp per build (scripts/build.mjs), so
// two bundles from the same build always agree — and a popup from a newer build than the service
// worker still running from the previous one does not, which is the whole point: an unpacked install
// that was updated but never reloaded answers every `readPassages` with `unknown request type`.
//
// `typeof` rather than a bare read is what makes this safe wherever the define never happened (vitest,
// a plain `tsx` import, any bundler that does not know the name): reading an undeclared identifier
// throws a ReferenceError, but `typeof` on one never does.

declare const __JD_BUILD__: string | undefined;

export const BUILD_ID: string = typeof __JD_BUILD__ === 'string' ? __JD_BUILD__ : 'dev';
```

- [ ] **Step 18: Run it to make sure it passes**

Run: `pnpm vitest run tests/unit/extension/build-id.test.ts`
Expected: PASS.

- [ ] **Step 19: Define `__JD_BUILD__` in the extension bundles only**

In `scripts/build.mjs`, above the `extEntries` array (after the CLI build block), add:

```js
// One stamp per build, handed to every EXTENSION bundle and to none of the CLI's: the popup compares
// its own against the service worker's and refuses to read when they differ, which is what turns
// "65 errors" into "reload the extension" before anything is clicked (design addendum §3.3).
const buildId = new Date().toISOString();
```

and inside the `for (const { entry, out, format, footer } of extEntries)` loop, add the `define` to the `build({...})` call (between `target` and `minify`):

```js
    target: 'chrome120',
    define: { __JD_BUILD__: JSON.stringify(buildId) },
    minify: true,
```

- [ ] **Step 20: Build and confirm the stamp really landed in both bundles**

Run: `pnpm build && node -e "const {readFileSync}=require('node:fs');const bg=readFileSync('dist/extension/background.js','utf8');const p=readFileSync('dist/extension/popup.js','utf8');const m=bg.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);if(!m)throw new Error('no build stamp in background.js');if(!p.includes(m[0]))throw new Error('popup.js carries a different stamp');if(bg.includes('__JD_BUILD__'))throw new Error('the define did not apply');console.log('build stamp:',m[0]);"`
Expected: prints `build stamp: <an ISO timestamp>` and exits 0.

- [ ] **Step 21: Write the failing popup stale-build tests**

In `tests/unit/extension/popup.test.ts`, add the two imports at the top:

```ts
import { BUILD_ID } from '../../../src/extension/build-id';
import { initPopup, STALE_POPUP_STATUS } from '../../../src/extension/popup/popup';
```

(replacing the existing `import { initPopup } from '../../../src/extension/popup/popup';`), and give every fabricated `getState` the field the real one now answers — in `getStateResponse`:

```ts
function getStateResponse(overrides: Partial<Settings> = {}, stats: DuoStats = STATS, exampleCount = 4, pageSeen: PageSeenReport[] = []): Response {
  return {
    ok: true,
    type: 'getState',
    settings: { ...SETTINGS, ...overrides, keys: { ...SETTINGS.keys, ...overrides.keys }, enabledSites: { ...SETTINGS.enabledSites, ...overrides.enabledSites } },
    stats,
    exampleCount,
    hasKeys: false,
    providers: { jev: 'mock', llm: 'mock' },
    pageSeen,
    // Under vitest both sides of the handshake are 'dev', so the default response is never stale.
    build: BUILD_ID,
  };
}
```

Then append to the `Read this page` describe block (the one that defines `withTabs` / `stateSend`):

```ts
    // --- Design addendum 2026-09-23 §3.3: say it before anything is clicked, not after 65 errors ---

    it('disables both read buttons and says so when the background is from another build', async () => {
      withTabs([{ id: 7, url: 'https://example.test/paper.pdf' }]);
      const doc = loadDoc();
      // Narrowed first: `getStateResponse` is typed as the whole `Response` union, and spreading that
      // union before overriding `build` is not assignable back to it.
      const state = getStateResponse();
      if (!state.ok || state.type !== 'getState') throw new Error('test: expected a getState response');
      const send = makeFakeSend((req) =>
        req.type === 'getState' ? { ...state, build: '2026-09-23T07:00:00.000Z' } : { ok: true, type: 'setSettings' },
      );

      await initPopup(doc, { send: asSend(send) });

      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').disabled).toBe(true);
      expect(el(doc, 'read-status').textContent).toBe(STALE_POPUP_STATUS);
      expect(el(doc, 'read-status').classList.contains('error')).toBe(true);
      expect(STALE_POPUP_STATUS).toBe('reload the extension at chrome://extensions (↻) to finish updating');
      // The rest of the popup keeps working: the settings still filled in.
      expect(el<HTMLTextAreaElement>(doc, 'intent').value).toBe('Hide crypto shilling.');

      doc.dispatchEvent(new Event('unload'));
    });

    it('leaves both read buttons alone when the builds match', async () => {
      withTabs([{ id: 7, url: 'https://example.test/paper.pdf' }]);
      const doc = loadDoc();

      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(false);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').disabled).toBe(false);
      expect(el(doc, 'read-status').textContent).toBe('');

      doc.dispatchEvent(new Event('unload'));
    });

    it('a getState that failed altogether changes nothing about the buttons', async () => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const doc = loadDoc();
      const send = makeFakeSend(() => ({ ok: false, error: 'Could not establish connection.' }));

      await initPopup(doc, { send: asSend(send) });

      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(false);
      expect(el(doc, 'read-status').textContent).toBe('');

      doc.dispatchEvent(new Event('unload'));
    });
```

- [ ] **Step 22: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts`
Expected: FAIL — `has no exported member 'STALE_POPUP_STATUS'`, and `Object literal may only specify known properties, and 'build' does not exist in type ...` on `getStateResponse`.

- [ ] **Step 23: Answer `build` from the background and check it in the popup**

In `src/extension/messages.ts`, add the field to the `getState` response (keeping the existing doc comment above it):

```ts
  | {
      ok: true;
      type: 'getState';
      settings: Settings;
      stats: DuoStats;
      exampleCount: number;
      hasKeys: boolean;
      providers: { jev: string; llm: string };
      pageSeen: PageSeenReport[];
      /** The service worker's own `BUILD_ID` (§3.3): the popup compares it with its own. */
      build: string;
    }
```

In `src/extension/background.ts`, import it near the other extension-local imports:

```ts
import { BUILD_ID } from './build-id';
```

and answer it:

```ts
      case 'getState':
        return { ok: true, type: 'getState', settings, stats: agent.stats(), exampleCount: agent.examples.size, hasKeys, providers, pageSeen: pageSeenReports(), build: BUILD_ID };
```

In `src/extension/popup/popup.ts`, import it and export the status string, next to `NO_PAGE_REPORT`/`ZERO_SEEN`:

```ts
import { BUILD_ID } from '../build-id';
```

```ts
/** §3.3. Shown instead of a read the popup already knows will fail: the service worker still running
 * is from an older build than this popup, so it has no `readPassages` handler at all. */
export const STALE_POPUP_STATUS = 'reload the extension at chrome://extensions (↻) to finish updating';
```

Add the check inside `initPopup`, right after `renderReading`:

```ts
  /** §3.3's whole handshake. Only ever SETS — a reload is the only cure, so nothing clears it — and it
   * touches nothing but the two read buttons and their status line, so the rest of the popup (settings,
   * keys, sites, stats) stays usable while the user goes and reloads. A failed `getState` never calls
   * this: nothing was learned, and the existing `loadFailed` path already says so. */
  function applyBuild(build: string): void {
    if (build === BUILD_ID) return;
    readPageBtn.disabled = true;
    readPdfBtn.disabled = true;
    setReadStatus(STALE_POPUP_STATUS, true);
  }
```

Call it from `refresh()`:

```ts
  async function refresh(): Promise<void> {
    const res = await send({ type: 'getState' });
    if (!res.ok || res.type !== 'getState') return;
    applyBuild(res.build);
    if (loadFailed) {
```

and from the initial load (after `renderReading()` has already run and set the buttons' normal state):

```ts
  const initial = await send({ type: 'getState' });
  if (initial.ok && initial.type === 'getState') {
    fillSettings(initial.settings);
    fillStats(initial.stats, initial.exampleCount);
    fillPageSeen(initial.pageSeen, tabId);
    brainStatusEl.textContent = `fast brain: ${initial.providers.jev} · slow brain: ${initial.providers.llm}`;
    applyBuild(initial.build);
  } else {
```

- [ ] **Step 24: Run the popup and background suites to make sure they pass**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts tests/unit/extension/background.test.ts`
Expected: PASS.

- [ ] **Step 25: Add the `@live-jev` test through the real extension**

Append to `tests/e2e/reading-live.spec.ts` (and extend its imports):

```ts
import { launchWithExtension, seedSettings } from './helpers';
import { FIXTURE_ORIGIN } from './server';
```

```ts
// §3.4. The core test above proves the fast brain separates substance from acknowledgments; this one
// proves the whole extension does — popup click, injection, service worker, real provider — and that
// it does it with ZERO errors, which is the regression the addendum exists for. It launches its own
// browser inside the test body, after the guards, so a plain `pnpm test:e2e` never pays for a Chromium
// launch it is about to skip.
test('reading mode: the built extension reads the article fixture with no errors', { tag: '@live-jev' }, async () => {
  test.skip(!LIVE, 'set LIVE=1 to run tests that need the public internet');
  test.skip(!JEV_KEY, 'set TYPESAFE_API_KEY (repo .env is loaded by playwright.config.ts) to run the live reading test');
  test.setTimeout(180_000);

  const ext = await launchWithExtension();
  try {
    await seedSettings(ext, { providerMode: 'typesafe', keys: { typesafe: JEV_KEY ?? '' }, focus: '' });

    const articleUrl = `${FIXTURE_ORIGIN}/article.html`;
    const article = await ext.context.newPage();
    await article.goto(articleUrl);

    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?jd-tab=${encodeURIComponent(articleUrl)}`);
    await popup.locator('#read-page').click();
    await expect(popup.locator('#read-status')).toHaveText('reading 21 passages');

    const progress = article.locator('#jd-reader .progress');
    await expect(progress).toHaveText(/^21 passages · /, { timeout: 120_000 });
    await expect(progress).not.toHaveText(/errors/);
    await expect(article.locator('#jd-reader p.error')).toHaveText('');
    expect(await article.locator('.jd-hl').count()).toBeGreaterThanOrEqual(1);
  } finally {
    await ext.close();
  }
});
```

- [ ] **Step 26: Run the whole gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green; the two `@live-jev` tests report as skipped (`set LIVE=1 to run tests that need the public internet`).

- [ ] **Step 27: Commit**

```bash
git add src/core/reading-judge.ts src/extension/build-id.ts src/extension/messages.ts src/extension/background.ts src/extension/reading/run.ts src/extension/reading/reader-ui.ts src/extension/popup/popup.ts scripts/build.mjs tests/unit/core/reading-judge.test.ts tests/unit/extension/build-id.test.ts tests/unit/extension/reader-ui.test.ts tests/unit/extension/popup.test.ts tests/unit/extension/background.test.ts tests/e2e/reading-live.spec.ts
git commit -m "$(cat <<'EOF'
feat(reading): carry the reason for an error, and warn about a stale install

The panel's summary gains a second line naming the last failure, and
`unknown request type` — what an unpacked install whose service worker was
never reloaded answers — becomes the reload hint instead. A build stamp
defined once per esbuild run rides on getState, so the popup disables both
read buttons and says to reload before anything is clicked.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Geometry and loading

Implements spec §5.1 (geometry), §5.2 (loading) and §5.3's **Assets** paragraph. Nothing in this task renders anything on screen — it is the arithmetic and the pdf.js surface Task 3 draws with.

**Files:**
- Modify: `src/extension/reading/pdf-text.ts`, `src/extension/reading/pdf-load.ts`, `scripts/build.mjs`
- Test: `tests/unit/extension/pdf-text.test.ts`, `tests/unit/extension/pdf-load.test.ts`, `tests/unit/extension/reader-page.test.ts` (type repair only), `tests/e2e/reading.spec.ts`

**Interfaces:**
- Consumes from Task 1: nothing. `scripts/build.mjs` already carries Task 1's `define: { __JD_BUILD__: ... }` in the extension loop; this task adds a separate copy loop below the worker copy and must not disturb it.
- Produces, for Task 3:
  - `src/extension/reading/pdf-text.ts`
    - `export interface Box { x: number; y: number; width: number; height: number }`
    - `export interface PageText { page: number; width: number; height: number; originX: number; originY: number; items: TextItem[] }`
    - `export type Block = { kind: 'heading'; text: string; page: number; box: Box } | { kind: 'passage'; text: string; page: number; box: Box }`
    - `export function toPercentBox(box: Box, page: { width: number; height: number; originX: number; originY: number }): { left: string; top: string; width: string; height: string }`
    - unchanged: `export function pagesToBlocks(pages: PageText[], fallbackTitle: string): PdfDoc`, `PdfDoc { title: string; blocks: Block[] }`, `TextItem`
  - `src/extension/reading/pdf-load.ts`
    - `export interface PdfAssets { standardFontDataUrl?: string; cMapUrl?: string; cMapPacked?: boolean; wasmUrl?: string }`
    - `export interface OpenedPdf { pages: PageText[]; metaTitle?: string; renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number): Promise<void>; destroy(): Promise<void> }`
    - `export async function openPdf(data: ArrayBuffer, pdfjs: PdfjsLike, assets?: PdfAssets): Promise<OpenedPdf>`
    - `export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }>` (unchanged signature; now `openPdf` + `destroy()` in a `finally`)
    - `export interface PdfjsLike { getDocument(params: Record<string, unknown>): PdfLoadingTaskLike }`, plus `PdfLoadingTaskLike`, `PdfDocumentLike`, `PdfPageLike`, `PdfViewportLike`, `PdfRenderTaskLike`
  - `dist/extension/{standard_fonts,cmaps,wasm}` exist after `pnpm build`.

- [ ] **Step 1: Give the pdf-text test helper page origins, and write the failing geometry tests**

In `tests/unit/extension/pdf-text.test.ts`, widen the imports and the `page` helper:

```ts
import { pagesToBlocks, toPercentBox, type Box, type PageText, type TextItem } from '../../../src/extension/reading/pdf-text';
```

```ts
/** A page of `items`. `origin` is `page.view[0]`/`[1]` — 0 for anything synthetic, non-zero only for a
 * cropped page, which the last toPercentBox case below covers directly. */
function page(n: number, items: TextItem[], origin: { x: number; y: number } = { x: 0, y: 0 }): PageText {
  return { page: n, width: PAGE_WIDTH, height: PAGE_HEIGHT, originX: origin.x, originY: origin.y, items };
}
```

Append two new `describe` blocks at the end of the file:

```ts
// --- Design addendum 2026-09-23 §5.1: where each block SITS, so the reader can draw on the page ---

describe('pagesToBlocks boxes', () => {
  const boxes = (pages: PageText[], kind: 'heading' | 'passage'): Box[] =>
    pagesToBlocks(pages, 'fallback').blocks.filter((b) => b.kind === kind).map((b) => b.box);

  it("a single line's box is one em above the baseline and a quarter em below it", () => {
    // `item` measures width as chars x size x 0.5, so this 43-character line is 215 pt wide.
    expect(boxes([page(1, [item(SENTENCE, 72, 700, 10)])], 'passage')).toEqual([{ x: 72, y: 697.5, width: 215, height: 12.5 }]);
  });

  it("a three-line block's box is the union of its lines' boxes", () => {
    const lines = [
      item(SENTENCE, 72, 700, 10), // 43 chars -> right 287
      item('Second line here.', 72, 686, 10), // 17 chars -> right 157
      item('A third line that is longer than the first one.', 72, 672, 10), // 47 chars -> right 307
    ];

    // x/width from the widest line, y from the lowest baseline's descent, top from the highest ascent.
    expect(boxes([page(1, lines)], 'passage')).toEqual([{ x: 72, y: 669.5, width: 235, height: 40.5 }]);
  });

  it('a two-column band gives the two blocks disjoint boxes', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const pages = [
      page(1, [
        full('A Two Column Paper', 740, 18),
        item(`LEFT. ${SENTENCE}`, 72, 700, 10, { width: 200 }),
        item('More of the left column here.', 72, 686, 10, { width: 200 }),
        item(`RIGHT. ${SENTENCE}`, 340, 700, 10, { width: 200 }),
        item('More of the right column here.', 340, 686, 10, { width: 200 }),
      ]),
    ];

    const [left, right] = boxes(pages, 'passage');
    expect(left).toEqual({ x: 72, y: 683.5, width: 200, height: 26.5 });
    expect(right).toEqual({ x: 340, y: 683.5, width: 200, height: 26.5 });
    expect(left.x + left.width).toBeLessThanOrEqual(right.x); // no overlap: two overlays, two columns
  });

  it('headings carry boxes too', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const pages = [page(1, [full('A Two Column Paper', 740, 18), item(SENTENCE, 72, 700, 10), item('More body text here.', 72, 686, 10)])];

    expect(boxes(pages, 'heading')).toEqual([{ x: 72, y: 735.5, width: 468, height: 22.5 }]);
  });
});

describe('toPercentBox', () => {
  const LETTER = { width: 612, height: 792, originX: 0, originY: 0 };

  it('projects a box on a letter page whose origin is (0, 0)', () => {
    expect(toPercentBox({ x: 61.2, y: 396, width: 306, height: 79.2 }, LETTER)).toEqual({
      left: '10.000%',
      top: '40.000%',
      width: '50.000%',
      height: '10.000%',
    });
  });

  it("subtracts a cropped page's origin from both axes", () => {
    // The same box, shifted by the origin: the same place on the page.
    expect(toPercentBox({ x: 71.2, y: 416, width: 306, height: 79.2 }, { width: 612, height: 792, originX: 10, originY: 20 })).toEqual({
      left: '10.000%',
      top: '40.000%',
      width: '50.000%',
      height: '10.000%',
    });
  });

  it('flips the y axis: a box near the top of the page has a small `top`', () => {
    expect(toPercentBox({ x: 0, y: 752.4, width: 612, height: 39.6 }, LETTER)).toMatchObject({ top: '0.000%', height: '5.000%' });
  });

  it('clamps a box that pokes past every edge', () => {
    expect(toPercentBox({ x: -50, y: -20, width: 1000, height: 900 }, LETTER)).toEqual({
      left: '0.000%',
      top: '0.000%',
      width: '100.000%',
      height: '100.000%',
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/pdf-text.test.ts`
Expected: FAIL — `has no exported member 'toPercentBox'` / `'Box'`, and `Object literal may only specify known properties, and 'originX' does not exist in type 'PageText'`.

- [ ] **Step 3: Add `Box`, the page origins, the block boxes and `toPercentBox`**

In `src/extension/reading/pdf-text.ts`, replace the `PageText`/`Block` declarations and add `Box`:

```ts
/** A rectangle in PDF user space: origin bottom-left, y up, points. The one geometry type the reader
 * page speaks — everything it draws goes through `toPercentBox` first. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  /** `page.view[0]`/`page.view[1]`: 0 for a synthetic page, non-zero for a cropped one, and the
   * reason `toPercentBox` subtracts rather than divides straight away. */
  originX: number;
  originY: number;
  items: TextItem[];
}

export type Block =
  | { kind: 'heading'; text: string; page: number; box: Box }
  | { kind: 'passage'; text: string; page: number; box: Box };
```

Add the two box helpers next to `isHeading`:

```ts
/** §5.1's line box: the baseline `y` with a quarter em of descent below it and one em of ascent above.
 * pdf.js reports a baseline and a width and nothing else, so the height is inferred from the size. */
const lineBox = (line: Line): Box => ({
  x: line.x,
  y: line.y - 0.25 * line.size,
  width: line.right - line.x,
  height: 1.25 * line.size,
});

/** The smallest box containing both. A block's box is its lines' boxes folded through this. */
function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
```

Carry it through `Draft` and `draftsOfPage`:

```ts
interface Draft {
  kind: 'heading' | 'passage';
  text: string;
  page: number;
  size: number;
  box: Box;
}
```

```ts
function draftsOfPage(ordered: Line[], body: number): Draft[] {
  const out: Draft[] = [];
  let prev: Line | undefined;
  let text = '';
  let size = 0;
  let page = 0;
  let box: Box = { x: 0, y: 0, width: 0, height: 0 };

  const flush = (): void => {
    if (text === '') return;
    // §6.1.7: a big short block is a heading, anything else long enough is a passage, the rest is
    // dropped — a stray line of page furniture never becomes something to judge.
    if (isHeading(size, text.length, body)) out.push({ kind: 'heading', text, page, size, box });
    else if (text.length >= MIN_PASSAGE_CHARS) out.push({ kind: 'passage', text, page, size, box });
    text = '';
  };

  for (const line of ordered) {
    const starts =
      prev === undefined ||
      prev.column !== line.column ||
      prev.y - line.y > GAP_FACTOR * prev.size ||
      Math.abs(line.size - prev.size) > SIZE_STEP ||
      isHeading(line.size, line.text.length, body);
    if (starts) {
      flush();
      text = line.text;
      size = line.size;
      page = line.page;
      box = lineBox(line);
    } else {
      text = joinInto(text, line.text);
      box = unionBox(box, lineBox(line));
    }
    prev = line;
  }
  flush();
  return out;
}
```

And copy it into the emitted block in `pagesToBlocks`:

```ts
    blocks.push({ kind: draft.kind, text: draft.text, page: draft.page, box: draft.box });
```

Finally, export the projection at the bottom of the file:

```ts
const clampPercent = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);
const percent = (v: number): string => `${clampPercent(v).toFixed(3)}%`;

/** §5.1. PDF user space to the CSS percentages an overlay is positioned by: subtract the page origin,
 * flip the y axis (PDF counts up from the bottom, CSS down from the top), scale to the page, clamp.
 *
 * Percentages, not pixels, is the whole trick: the overlays stay correct at any rendered canvas size,
 * so a window resize costs nothing to recompute and a canvas re-rendered at a new width needs no
 * second pass over the geometry. */
export function toPercentBox(
  box: Box,
  page: { width: number; height: number; originX: number; originY: number },
): { left: string; top: string; width: string; height: string } {
  return {
    left: percent(((box.x - page.originX) / page.width) * 100),
    top: percent(((page.originY + page.height - (box.y + box.height)) / page.height) * 100),
    width: percent((box.width / page.width) * 100),
    height: percent((box.height / page.height) * 100),
  };
}
```

Also fill the two origins in `src/extension/reading/pdf-load.ts`'s existing `loadPages` loop so the module still compiles (Step 9 rewrites this file properly):

```ts
      pages.push({
        page: n,
        width: num(view[2]) - num(view[0]),
        height: num(view[3]) - num(view[1]),
        originX: num(view[0]),
        originY: num(view[1]),
        items: content.items.map(toTextItem).filter((i): i is TextItem => i !== undefined),
      });
```

- [ ] **Step 4: Run the geometry tests to make sure they pass**

Run: `pnpm vitest run tests/unit/extension/pdf-text.test.ts`
Expected: PASS (all existing cases plus the eight new ones).

- [ ] **Step 5: Repair the `PdfDoc` literals in the reader-page test**

`Block` now has a required `box`, so the five `PdfDoc` literals in `tests/unit/extension/reader-page.test.ts` no longer type-check. Add one shared box just under the imports:

```ts
/** Every block now carries the box its overlay is positioned from (§5.1). These cases are about the
 * page marks and the heading/passage split, so one arbitrary body-line box serves all of them; the
 * geometry itself is covered in pdf-text.test.ts. */
const BOX = { x: 72, y: 697.5, width: 215, height: 12.5 };
```

and add `box: BOX` to every block literal in the file, e.g.:

```ts
    const doc: PdfDoc = { title: 'One Page', blocks: [{ kind: 'passage', text: 'x'.repeat(50), page: 1, box: BOX }] };
```

```ts
      blocks: [
        { kind: 'passage', text: 'a'.repeat(50), page: 1, box: BOX },
        { kind: 'passage', text: 'b'.repeat(50), page: 3, box: BOX }, // page 2 contributed nothing (e.g. a figure-only page)
      ],
```

```ts
      blocks: [
        { kind: 'heading', text: '1 Introduction', page: 1, box: BOX },
        { kind: 'passage', text: 'x'.repeat(50), page: 1, box: BOX },
      ],
```

```ts
    const doc: PdfDoc = { title: 'Scanned', blocks: [{ kind: 'heading', text: 'Title only', page: 1, box: BOX }] };
```

(the fifth literal, `{ title: 'T', blocks: [] }`, needs no change).

- [ ] **Step 6: Typecheck and run the whole unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — no `box`/`originX` errors anywhere.

- [ ] **Step 7: Write the failing `openPdf` / `renderPage` tests**

In `tests/unit/extension/pdf-load.test.ts`, widen the imports:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
```

```ts
import { loadPages, openPdf, type PdfjsLike, type PdfPageLike } from '../../../src/extension/reading/pdf-load';
```

Append a case to the existing `describe('loadPages on tests/e2e/fixtures/sample.pdf', ...)`:

```ts
  it('openPdf reports the page origins and hands back a working destroy', async () => {
    const opened = await openPdf(await sampleBytes(), await legacyPdfjs());
    try {
      expect(opened.metaTitle).toBe('Sample Paper');
      expect(opened.pages.map((p) => p.page)).toEqual([1, 2]);
      // An uncropped letter page: MediaBox starts at (0, 0), so both origins are 0.
      expect(opened.pages.map((p) => [p.originX, p.originY])).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(opened.pages[0].width).toBe(612);
      expect(opened.pages[0].height).toBe(792);
    } finally {
      await opened.destroy(); // the loading task, not just the document: no worker is left alive
    }
  });
```

Then append two new `describe` blocks:

```ts
// --- Design addendum 2026-09-23 §5.2: the page as PIXELS, against a pdf.js that is not pdf.js ---

/** A one-page pdf.js stand-in. `getViewport({ scale })` scales a letter page; `render` records the
 * `{ canvas, viewport }` it was handed (pdf.js 6 takes the canvas itself, not a 2d context) and
 * resolves — or rejects — with whatever `onRender` does. */
function fakePdfjs(onRender: () => Promise<void> = () => Promise.resolve()): {
  pdfjs: PdfjsLike;
  calls: Array<{ canvas: HTMLCanvasElement; viewport: { width: number; height: number } }>;
  params: Array<Record<string, unknown>>;
} {
  const calls: Array<{ canvas: HTMLCanvasElement; viewport: { width: number; height: number } }> = [];
  const params: Array<Record<string, unknown>> = [];
  const page: PdfPageLike = {
    view: [0, 0, 612, 792],
    async getTextContent() {
      return { items: [] };
    },
    getViewport({ scale }) {
      return { width: 612 * scale, height: 792 * scale };
    },
    render(args) {
      calls.push(args);
      return { promise: onRender() };
    },
  };
  const pdfjs: PdfjsLike = {
    getDocument(p) {
      params.push(p);
      return {
        promise: Promise.resolve({ numPages: 1, getPage: async () => page, getMetadata: async () => ({}) }),
        destroy: async () => {},
      };
    },
  };
  return { pdfjs, calls, params };
}

/** This file runs under the node environment (no DOM at all), and `renderPage` only ever writes
 * `width`/`height` — so a bare object is the honest stand-in for a canvas here. */
const fakeCanvas = (): HTMLCanvasElement => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('openPdf renderPage', () => {
  it('sizes the canvas from cssWidth x pixelRatio, rounding up, and renders exactly once', async () => {
    const { pdfjs, calls } = fakePdfjs();
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);
    const canvas = fakeCanvas();

    await opened.renderPage(1, canvas, 800, 2);

    // scale = 800 / 612 x 2 = 2.6143…; 612 x scale is exactly 1600, 792 x scale is 2070.588… -> 2071.
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(2071);
    expect(calls).toHaveLength(1);
    expect(calls[0].canvas).toBe(canvas);
    expect(calls[0].viewport.width).toBe(1600);
  });

  it('propagates a rejecting render to the caller rather than swallowing it', async () => {
    const { pdfjs } = fakePdfjs(() => Promise.reject(new Error('canvas is gone')));
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);

    await expect(opened.renderPage(1, fakeCanvas(), 800, 2)).rejects.toThrow('canvas is gone');
  });

  it('passes the runtime assets and both hardening flags to getDocument', async () => {
    const { pdfjs, params } = fakePdfjs();

    const opened = await openPdf(new ArrayBuffer(8), pdfjs, {
      standardFontDataUrl: 'chrome-extension://x/standard_fonts/',
      cMapUrl: 'chrome-extension://x/cmaps/',
      cMapPacked: true,
      wasmUrl: 'chrome-extension://x/wasm/',
    });
    await opened.destroy();

    expect(params[0]).toMatchObject({
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: 'chrome-extension://x/standard_fonts/',
      cMapUrl: 'chrome-extension://x/cmaps/',
      cMapPacked: true,
      wasmUrl: 'chrome-extension://x/wasm/',
    });
  });
});
```

And, inside the existing `describe('pdfjs-dist packaging', ...)`, add the source-side half of §6's build assertion:

```ts
  // §5.3's assets. pdf.js keeps three things out of its bundle and fetches them at runtime, so the
  // build has to copy them next to the reader. The COPIES are asserted by tests/e2e/reading.spec.ts,
  // which always runs against a real `pnpm build`; this side asserts the sources exist and that the
  // build script names all three, because `pnpm check` runs `pnpm test` BEFORE `pnpm build` and a
  // unit test that read dist/ would fail on a clean tree.
  it('the standard fonts, cmaps and wasm decoders are present and named by the build script', () => {
    for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
      const dir = path.join(ROOT, 'node_modules', 'pdfjs-dist', folder);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    }
    expect(readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8')).toContain("['standard_fonts', 'cmaps', 'wasm']");
  });
```

- [ ] **Step 8: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/pdf-load.test.ts`
Expected: FAIL — `has no exported member 'openPdf'` / `'PdfPageLike'` has no `getViewport`, and `to contain "['standard_fonts', 'cmaps', 'wasm']"`.

- [ ] **Step 9: Rewrite `pdf-load.ts` around `openPdf`**

Replace everything from the type declarations down in `src/extension/reading/pdf-load.ts` (the file header comment, `num`, `toTextItem` and `metaTitleOf` stay exactly as they are):

```ts
export interface PdfViewportLike {
  width: number;
  height: number;
}

export interface PdfRenderTaskLike {
  promise: Promise<void>;
}

export interface PdfPageLike {
  /** [x0, y0, x1, y1] in PDF user space. */
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(params: { scale: number }): PdfViewportLike;
  /** pdf.js 6 takes the canvas itself, not a 2d context. */
  render(params: { canvas: HTMLCanvasElement; viewport: PdfViewportLike }): PdfRenderTaskLike;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<unknown>;
}

/** What `getDocument` really returns: the loading TASK, not just its promise. Destroying the task is
 * what tears the worker down and releases the file — the document alone cannot. */
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(params: Record<string, unknown>): PdfLoadingTaskLike;
}

/** The three things pdf.js fetches at runtime instead of bundling (§5.3), as extension-origin URLs.
 * Without the standard fonts a PDF set in Times renders blank; without the cmaps CJK-encoded text
 * extracts as mojibake; without the wasm decoders a JPX/JBIG2 image throws mid-render. */
export interface PdfAssets {
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
  wasmUrl?: string;
}

export interface OpenedPdf {
  pages: PageText[];
  metaTitle?: string;
  /** Draws page `pageNumber` into `canvas` at `cssWidth` CSS pixels wide, `pixelRatio` device pixels
   * to each. Rejects with whatever pdf.js rejected with: what a failed page means is the caller's
   * decision, and the reader page's answer (§5.3) is to show that page's text instead. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number): Promise<void>;
  /** Destroys the loading task. The reader calls this before opening the next document. */
  destroy(): Promise<void>;
}

/** §5.2. Unlike `loadPages` this keeps the document OPEN — that is the whole difference, and the whole
 * point: a reader that draws the pages needs the same worker alive for as long as it is on screen.
 *
 * `isEvalSupported: false` keeps pdf.js from compiling font programs with `eval` (the extension CSP
 * forbids it anyway); `useSystemFonts: false` keeps it from reaching for local fonts it does not need. */
export async function openPdf(data: ArrayBuffer, pdfjs: PdfjsLike, assets: PdfAssets = {}): Promise<OpenedPdf> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, ...assets });
  const doc = await task.promise;

  const pages: PageText[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const view = page.view;
    pages.push({
      page: n,
      width: num(view[2]) - num(view[0]),
      height: num(view[3]) - num(view[1]),
      originX: num(view[0]),
      originY: num(view[1]),
      items: content.items.map(toTextItem).filter((i): i is TextItem => i !== undefined),
    });
  }
  const metaTitle = metaTitleOf(await doc.getMetadata());

  return {
    pages,
    metaTitle,
    async renderPage(pageNumber, canvas, cssWidth, pixelRatio) {
      const page = await doc.getPage(pageNumber); // pdf.js caches pages, so a re-render is cheap
      // The UNSCALED viewport, not `page.view`: it is what pdf.js renders against, and it already
      // accounts for a page's /Rotate, which the raw MediaBox does not.
      const base = page.getViewport({ scale: 1 });
      const scale = (cssWidth / base.width) * pixelRatio;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
    },
    async destroy() {
      await task.destroy?.();
    },
  };
}

/** The text-only path, unchanged for its callers and its tests: open, take the text, always close.
 * `pagesToBlocks` never needs the document again, so nothing is gained by holding the worker open. */
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }> {
  const opened = await openPdf(data, pdfjs);
  try {
    return { pages: opened.pages, metaTitle: opened.metaTitle };
  } finally {
    await opened.destroy();
  }
}
```

- [ ] **Step 10: Run the pdf-load tests**

Run: `pnpm vitest run tests/unit/extension/pdf-load.test.ts`
Expected: the three `openPdf` cases and both `loadPages` cases PASS; the packaging case still FAILS on `toContain("['standard_fonts', 'cmaps', 'wasm']")` (Step 11 fixes that).

- [ ] **Step 11: Copy the pdf.js runtime assets in the build**

In `scripts/build.mjs`, directly after the `pdf.worker.mjs` copy (`outputs.push(rel(workerDest));`), add:

```js
// pdf.js keeps three things out of its bundle and fetches them at runtime: the standard 14 font
// programs, the CJK cmaps, and the wasm decoders for JPX/JBIG2 images. They are copied to the
// extension's own origin (about 4 MB together, so the zip grows by roughly that), where reader.ts
// points getDocument at them with chrome.runtime.getURL — which the default extension CSP allows and
// which needs no web_accessible_resources entry, exactly like the worker above. Same guard, too: a
// missing folder is a one-line build failure rather than a PDF that renders blank at runtime.
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
  const from = path.join(root, 'node_modules', 'pdfjs-dist', folder);
  if (!existsSync(from)) {
    console.error(`build: no ${folder} in node_modules/pdfjs-dist — run \`pnpm install\` first`);
    process.exit(1);
  }
  const dest = path.join(extDist, folder);
  await cp(from, dest, { recursive: true });
  outputs.push(rel(dest));
}
```

- [ ] **Step 12: Run the test, then build and look at the result**

Run: `pnpm vitest run tests/unit/extension/pdf-load.test.ts && pnpm build && ls dist/extension`
Expected: PASS, then a successful build whose listing includes `standard_fonts`, `cmaps` and `wasm` alongside `pdf.worker.mjs`.

- [ ] **Step 13: Assert the copies from the e2e, which always runs after a build**

In `tests/e2e/reading.spec.ts`, add the `node:fs` import at the top:

```ts
import { existsSync, readdirSync } from 'node:fs';
```

and append this test (it needs no browser, but lives here because it is about the reader's assets):

```ts
// §5.3's assets, from the other side: tests/e2e/server.ts's globalSetup guarantees dist/ was built,
// so this is the half of the build assertion that can honestly say "after `pnpm build`".
test("the build ships pdf.js's fonts, cmaps and wasm decoders next to the reader", () => {
  for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
    const dir = path.join(ROOT, 'dist', 'extension', folder);
    expect(existsSync(dir), `dist/extension/${folder} is missing — scripts/build.mjs did not copy it`).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 14: Run the whole gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green. The e2e's existing reader tests still pass unchanged — `loadPages` behaves exactly as before, and nothing yet renders a canvas.

- [ ] **Step 15: Commit**

```bash
git add src/extension/reading/pdf-text.ts src/extension/reading/pdf-load.ts scripts/build.mjs tests/unit/extension/pdf-text.test.ts tests/unit/extension/pdf-load.test.ts tests/unit/extension/reader-page.test.ts tests/e2e/reading.spec.ts
git commit -m "$(cat <<'EOF'
feat(reading): give every block a box, and open PDFs for rendering

pdf-text gains Box, page origins, per-block boxes (the union of their line
boxes) and toPercentBox, which projects PDF user space onto the CSS
percentages an overlay is positioned by. pdf-load gains openPdf, which keeps
the loading task alive so pages can be drawn to a canvas; loadPages is now a
destroy-in-finally wrapper over it. The build copies pdf.js's standard fonts,
cmaps and wasm decoders next to the reader.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The reader page, rendered in place

Implements spec §4 (same tab, **Back**), §5.3 (the rendered page), §6's e2e list and §7 (docs).

**Files:**
- Create: `src/extension/reader/pages.ts`, `tests/unit/extension/reader-pages.test.ts`
- Modify: `src/extension/reader/reader.ts`, `src/extension/reader/reader.html`, `src/extension/reader/reader.css`, `src/extension/popup/popup.ts`, `tests/unit/extension/chrome-stub.ts`, `tests/unit/extension/reader-page.test.ts`, `tests/unit/extension/popup.test.ts`, `tests/e2e/reading.spec.ts`, `README.md`

**Interfaces:**
- Consumes from Task 1: `runReading(deps): Promise<{ ms; usageTokens; errors; lastError? }>` (unchanged call site); `STALE_POPUP_STATUS` and `applyBuild` already in `popup.ts` — the `readPdfBtn` this task re-wires is the same button `applyBuild` disables, so the stale path must keep working.
- Consumes from Task 2: `toPercentBox(box, page)`; `Box`; `PageText` with `originX`/`originY`; `Block` with `box`; `openPdf(data, pdfjs, assets?): Promise<OpenedPdf>` with `OpenedPdf.renderPage(pageNumber, canvas, cssWidth, pixelRatio)` and `OpenedPdf.destroy()`; `PdfAssets`; `dist/extension/{standard_fonts,cmaps,wasm}`.
- Produces (nothing depends on it — this is the last task):
  - `src/extension/reader/pages.ts` → `render(doc: PdfDoc, pages: PageText[], container: HTMLElement): RenderedDoc`; `mountPageRenderer(deps: PageRendererDeps): PageRenderer`; `PageSection`, `RenderedDoc`, `RenderPageFn`, `ObserveFactory`, `ResizeFactory`, `VisibilityObserver`, `PageRenderer`, `PageRendererDeps`; `OBSERVER_ROOT_MARGIN`, `RENDER_CONCURRENCY`, `RELEASE_PAGE_DISTANCE`, `RESIZE_WIDTH_CHANGE`, `RESIZE_DEBOUNCE_MS`.
  - `src/extension/reader/reader.ts` keeps exporting `NO_TEXT_STATUS`, `NOT_A_PDF_URL_STATUS`, `errMessage`, `parseErrorStatus`, `isFetchableUrl`, `arxivHtmlUrl` and **no longer exports `render`**.
  - `tests/unit/extension/chrome-stub.ts` → `ChromeStub` gains `updatedTabs(): Array<{ tabId: number; url: string }>`.

- [ ] **Step 1: Write the failing `render` tests**

Create `tests/unit/extension/reader-pages.test.ts`:

```ts
// @vitest-environment jsdom
//
// The reader page's document, without the reader page (design addendum §5.3): `render` takes a parsed
// PdfDoc plus its PageText[] and builds sections, canvases and overlays; `mountPageRenderer` decides
// which canvases get drawn and when. Neither touches chrome.*, fetch or pdf.js — which is the whole
// reason they live in pages.ts rather than reader.ts.
//
// jsdom has NO IntersectionObserver and NO ResizeObserver, so both are injected here. That is not a
// test convenience: it is the same seam the real page uses, with the real page passing the real ones.

import { describe, expect, it } from 'vitest';
import type { Box, PageText, PdfDoc } from '../../../src/extension/reading/pdf-text';
import { mountPageRenderer, render, type ObserveFactory, type RenderPageFn, type ResizeFactory } from '../../../src/extension/reader/pages';

const letter = (n: number): PageText => ({ page: n, width: 612, height: 792, originX: 0, originY: 0, items: [] });

/** The three-line body block from pdf-text.test.ts, so the percentages below are traceable. */
const BODY: Box = { x: 72, y: 669.5, width: 235, height: 40.5 };
const HEAD: Box = { x: 72, y: 735.5, width: 468, height: 22.5 };

const PAGES: PageText[] = [letter(1), letter(2)];

const DOC: PdfDoc = {
  title: 'Sample Paper',
  blocks: [
    { kind: 'heading', text: '1 Introduction', page: 1, box: HEAD },
    { kind: 'passage', text: 'First passage of page one, long enough to be one.', page: 1, box: BODY },
    { kind: 'passage', text: 'Second passage of page one, also long enough to be one.', page: 1, box: BODY },
    { kind: 'passage', text: 'The only passage on page two, long enough to be one.', page: 2, box: BODY },
  ],
};

/** Many identical pages, each with one passage, for the observer cases. */
function bigDoc(pageCount: number): { doc: PdfDoc; pages: PageText[] } {
  const pages = Array.from({ length: pageCount }, (_, i) => letter(i + 1));
  const doc: PdfDoc = {
    title: 'Long',
    blocks: pages.map((p) => ({ kind: 'passage' as const, text: `The only passage on page ${p.page}, long enough to be one.`, page: p.page, box: BODY })),
  };
  return { doc, pages };
}

/** Flushes the microtask queue across a macrotask boundary, so a `finally` behind two awaits has run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An observer a test drives by hand: `enter`/`leave` are what a real IntersectionObserver reports. */
function fakeObserver(): { factory: ObserveFactory; enter(page: number): void; leave(page: number): void } {
  let notify: ((page: number, visible: boolean) => void) | undefined;
  return {
    factory: (_sections, onChange) => {
      notify = onChange;
      return {
        disconnect: () => {
          notify = undefined;
        },
      };
    },
    enter: (page) => notify?.(page, true),
    leave: (page) => notify?.(page, false),
  };
}

/** A renderer that never settles on its own: each call parks until the test resolves or rejects it. */
function fakeRenderer(): { calls: number[]; pending: Array<{ resolve(): void; reject(err: Error): void }>; renderPage: RenderPageFn } {
  const calls: number[] = [];
  const pending: Array<{ resolve(): void; reject(err: Error): void }> = [];
  const renderPage: RenderPageFn = (page) =>
    new Promise<void>((resolve, reject) => {
      calls.push(page);
      pending.push({ resolve: () => resolve(), reject });
    });
  return { calls, pending, renderPage };
}

const noResize: ResizeFactory = () => ({ disconnect: () => {} });

/** jsdom gives every element a clientWidth of 0; the resize case needs real numbers. */
const setWidth = (el: HTMLElement, px: number): void => Object.defineProperty(el, 'clientWidth', { value: px, configurable: true });

describe('render', () => {
  it('builds one section per page, with the page proportions, a mark and a canvas', () => {
    const container = document.createElement('main');

    const { sections } = render(DOC, PAGES, container);

    const built = [...container.querySelectorAll<HTMLElement>('section.jd-page')];
    expect(built).toHaveLength(2);
    expect(built.map((s) => s.style.aspectRatio)).toEqual(['612 / 792', '612 / 792']);
    expect(built.map((s) => s.dataset.page)).toEqual(['1', '2']);
    expect([...container.querySelectorAll('.jd-page-mark')].map((m) => m.textContent)).toEqual(['p. 1', 'p. 2']);
    expect(container.querySelectorAll('canvas.jd-canvas')).toHaveLength(2);
    expect(container.querySelector('h1')?.textContent).toBe('Sample Paper');
    expect(sections.map((s) => s.page)).toEqual([1, 2]);
  });

  it('overlays only the passages, indexed in document order across pages', () => {
    const container = document.createElement('main');

    const { passages } = render(DOC, PAGES, container);

    const blocks = [...container.querySelectorAll<HTMLElement>('.jd-block')];
    expect(blocks).toHaveLength(3); // the heading is drawn on the canvas, never overlaid
    expect(blocks.map((b) => b.dataset.index)).toEqual(['0', '1', '2']);
    expect(blocks.map((b) => b.dataset.page)).toEqual(['1', '1', '2']);
    expect(passages.map((p) => p.el)).toEqual(blocks); // the overlays ARE the ArticlePassage elements
    expect(passages.map((p) => p.page)).toEqual([1, 1, 2]);
    expect(passages[0].text).toBe('First passage of page one, long enough to be one.');
  });

  it('positions each overlay with toPercentBox, in percentages', () => {
    const container = document.createElement('main');

    render(DOC, PAGES, container);

    // BODY on a 612 x 792 page with a (0, 0) origin.
    const first = container.querySelector<HTMLElement>('.jd-block');
    expect(first?.style.left).toBe('11.765%');
    expect(first?.style.top).toBe('10.354%');
    expect(first?.style.width).toBe('38.399%');
    expect(first?.style.height).toBe('5.114%');
  });

  it('renders a page that contributed no text at all — it still has a picture', () => {
    const container = document.createElement('main');
    const doc: PdfDoc = { title: 'Figure', blocks: [{ kind: 'passage', text: 'Only page two has words in it here.', page: 2, box: BODY }] };

    const { sections } = render(doc, PAGES, container);

    expect(sections).toHaveLength(2);
    expect(sections[0].blocks).toHaveLength(0);
    expect(sections[1].blocks).toHaveLength(1);
  });

  it('clears the container first, so a re-read does not stack two documents', () => {
    const container = document.createElement('main');
    container.textContent = 'stale content from a previous read';

    render({ title: 'T', blocks: [] }, [], container);

    expect(container.textContent).toBe('T');
    expect(container.querySelectorAll('.jd-page')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/reader-pages.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/reader/pages"`.

- [ ] **Step 3: Write the failing lazy-renderer tests**

Append to `tests/unit/extension/reader-pages.test.ts`:

```ts
describe('mountPageRenderer', () => {
  function mount(pageCount: number) {
    const container = document.createElement('main');
    const { doc, pages } = bigDoc(pageCount);
    const { sections } = render(doc, pages, container);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    const handle = mountPageRenderer({
      sections,
      renderPage: renderer.renderPage,
      observe: observer.factory,
      onResize: noResize,
      pixelRatio: () => 2,
    });
    return { sections, observer, renderer, handle };
  }

  it('draws nothing until a section comes into view', () => {
    const { renderer, handle } = mount(4);

    expect(renderer.calls).toEqual([]);
    expect(handle.rendered()).toEqual([]);
  });

  it('draws a section that comes into view, at its own width and the given pixel ratio', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    setWidth(sections[0].section, 800);
    const observer = fakeObserver();
    const widths: Array<[number, number, number]> = [];
    const renderPage: RenderPageFn = (page, _canvas, cssWidth, pixelRatio) => {
      widths.push([page, cssWidth, pixelRatio]);
      return Promise.resolve();
    };
    const handle = mountPageRenderer({ sections, renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    await flush();

    expect(widths).toEqual([[1, 800, 2]]);
    expect(handle.rendered()).toEqual([1]);
  });

  it('releases a canvas more than 8 pages from the nearest visible section, and draws it again on approach', async () => {
    const { sections, observer, renderer, handle } = mount(20);

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    expect(handle.rendered()).toEqual([1]);

    // Scrolled away: page 1 is now 11 pages from the only visible section.
    observer.leave(1);
    observer.enter(12);
    expect(handle.rendered()).toEqual([]);
    expect(sections[0].canvas.width).toBe(0);
    expect(sections[0].canvas.height).toBe(0);
    renderer.pending[1].resolve();
    await flush();
    expect(handle.rendered()).toEqual([12]);

    // Back again: a released canvas is re-drawn rather than left blank.
    observer.leave(12);
    observer.enter(1);
    renderer.pending[2].resolve();
    await flush();

    expect(renderer.calls).toEqual([1, 12, 1]);
    expect(handle.rendered()).toEqual([1]);
  });

  it('keeps a canvas 8 pages away: the release rule is strictly beyond, not at', async () => {
    const { observer, renderer, handle } = mount(20);

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    observer.leave(1);
    observer.enter(9); // exactly 8 pages from page 1

    expect(handle.rendered()).toEqual([1]);
  });

  it('keeps at most two renders in flight, starting the next as one finishes', async () => {
    const { observer, renderer } = mount(6);

    observer.enter(1);
    observer.enter(2);
    observer.enter(3);
    observer.enter(4);
    expect(renderer.calls).toEqual([1, 2]);

    renderer.pending[0].resolve();
    await flush();
    expect(renderer.calls).toEqual([1, 2, 3]); // FIFO: page 3 was queued before page 4

    renderer.pending[1].resolve();
    await flush();
    expect(renderer.calls).toEqual([1, 2, 3, 4]);
  });

  it('never queues the same page twice', async () => {
    const { observer, renderer } = mount(4);

    observer.enter(1);
    observer.enter(1);
    observer.enter(1);
    await flush();

    expect(renderer.calls).toEqual([1]);
  });

  it("a page whose render rejects shows its passages' text instead, and only that page", async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    mountPageRenderer({ sections, renderPage: renderer.renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    renderer.pending[0].reject(new Error('canvas context lost'));
    await flush();

    expect(sections[0].section.classList.contains('jd-render-failed')).toBe(true);
    const failed = sections[0].blocks.map((b) => b.el);
    expect(failed.every((el) => el.classList.contains('jd-block-text'))).toBe(true);
    expect(failed[0].textContent).toBe('First passage of page one, long enough to be one.');
    expect(sections[1].section.classList.contains('jd-render-failed')).toBe(false);
    expect(sections[1].blocks[0].el.textContent).toBe('');
  });

  it('keeps a highlight tag the panel had already put on an overlay when the page fails', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    const tag = document.createElement('span');
    tag.className = 'jd-rtag';
    tag.textContent = 'method · 95%';
    sections[0].blocks[0].el.appendChild(tag);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    mountPageRenderer({ sections, renderPage: renderer.renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    renderer.pending[0].reject(new Error('canvas context lost'));
    await flush();

    // The element never changes identity (a running judge still owns it) and keeps its tag.
    expect(sections[0].blocks[0].el.querySelector('.jd-rtag')).toBe(tag);
    expect(sections[0].blocks[0].el.textContent).toContain('First passage of page one');
  });

  it('re-renders a drawn page when its width moves by more than a quarter, and not otherwise', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    setWidth(sections[0].section, 800);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    let fireResize = (): void => {};
    mountPageRenderer({
      sections,
      renderPage: renderer.renderPage,
      observe: observer.factory,
      onResize: (_s, run) => {
        fireResize = run;
        return { disconnect: () => {} };
      },
      pixelRatio: () => 2,
    });

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    expect(renderer.calls).toEqual([1]);

    setWidth(sections[0].section, 900); // +12.5 %: the browser's own scaling is good enough
    fireResize();
    expect(renderer.calls).toEqual([1]);

    setWidth(sections[0].section, 1200); // +50 %: redraw at the new width
    fireResize();
    expect(renderer.calls).toEqual([1, 1]);
  });

  it('destroy stops the observers and the queue', async () => {
    const { observer, renderer, handle } = mount(6);

    observer.enter(1);
    observer.enter(2);
    observer.enter(3);
    handle.destroy();
    renderer.pending[0].resolve();
    await flush();

    expect(renderer.calls).toEqual([1, 2]); // the queued page 3 never starts
    observer.enter(4); // the fake's notify is gone after disconnect
    expect(renderer.calls).toEqual([1, 2]);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/reader-pages.test.ts`
Expected: FAIL — still `Failed to resolve import ".../reader/pages"`.

- [ ] **Step 5: Create `src/extension/reader/pages.ts`**

```ts
// The reader page's document: one <section> per PDF page, a canvas pdf.js draws that page on, and one
// absolutely-positioned overlay per passage (design addendum §5.3). The overlays ARE the
// `ArticlePassage.el` handed to mountReader, so READER_CSS's jd-hl/jd-dim/jd-flash, the panel's
// scroll-to-row and the whole judging loop work on them with no special case anywhere in reading/.
//
// Nothing here touches chrome.*, fetch or pdf.js: it takes a parsed PdfDoc, its PageText[] and a
// render function — which is what makes all of it testable in jsdom. IntersectionObserver and
// ResizeObserver do not exist in jsdom at all, so both are behind injectable factories whose defaults
// are `typeof`-guarded no-ops: importing this module in a test observes nothing and renders nothing.

import { passageId } from '../../core/reading';
import type { ArticlePassage } from '../reading/article';
import { toPercentBox, type Block, type PageText, type PdfDoc } from '../reading/pdf-text';

/** A page and a half of viewport in each direction, so a canvas is normally drawn before it is seen. */
export const OBSERVER_ROOT_MARGIN = '150% 0px';
/** At most this many renders in flight. Two keeps a fast scroll responsive without spending the main
 * thread rasterising pages that have already gone past. */
export const RENDER_CONCURRENCY = 2;
/** A drawn canvas further than this many pages from the nearest visible section is released. A letter
 * page at 2x on a wide window is ~13 MB of backing store; a hundred of them is a killed tab. */
export const RELEASE_PAGE_DISTANCE = 8;
/** Re-render when a section's width has moved by more than this share of the width it was drawn at.
 * Under that, the browser's own scaling of the existing bitmap is not worth a re-raster. */
export const RESIZE_WIDTH_CHANGE = 0.25;
export const RESIZE_DEBOUNCE_MS = 300;

export interface PageSection {
  page: number;
  section: HTMLElement;
  canvas: HTMLCanvasElement;
  /** This page's overlays, in document order — what the render-failure fallback fills with text. */
  blocks: Array<{ text: string; el: HTMLElement }>;
}

export interface RenderedDoc {
  passages: ArticlePassage[];
  sections: PageSection[];
}

/** §5.3. Builds the document into `container` (cleared first): a small <h1> with the title, then one
 * section per PAGE — including a page that contributed no text at all, which still has a picture worth
 * showing. Heading blocks get no overlay: they are already drawn on the canvas and are never judged.
 * Passage indexes run in document order across pages; the MAX_PASSAGES cap has already been applied,
 * by `pagesToBlocks`, to `doc.blocks`. */
export function render(doc: PdfDoc, pages: PageText[], container: HTMLElement): RenderedDoc {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = doc.title;
  container.appendChild(h1);

  const byPage = new Map<number, Block[]>();
  for (const block of doc.blocks) {
    if (block.kind !== 'passage') continue;
    const list = byPage.get(block.page);
    if (list) list.push(block);
    else byPage.set(block.page, [block]);
  }

  const passages: ArticlePassage[] = [];
  const sections: PageSection[] = [];
  for (const pageText of pages) {
    const section = document.createElement('section');
    section.className = 'jd-page';
    section.dataset.page = String(pageText.page);
    // The page's own proportions, so the section reserves the right space before anything is drawn:
    // that is what keeps the overlays in place and the scroll position stable while canvases are
    // drawn and released underneath them.
    section.style.aspectRatio = `${pageText.width} / ${pageText.height}`;

    const mark = document.createElement('div');
    mark.className = 'jd-page-mark';
    mark.textContent = `p. ${pageText.page}`;

    const canvas = document.createElement('canvas');
    canvas.className = 'jd-canvas';
    section.append(mark, canvas);

    const blocks: PageSection['blocks'] = [];
    for (const block of byPage.get(pageText.page) ?? []) {
      const el = document.createElement('div');
      el.className = 'jd-block';
      el.dataset.index = String(passages.length);
      el.dataset.page = String(pageText.page);
      const box = toPercentBox(block.box, pageText);
      el.style.left = box.left;
      el.style.top = box.top;
      el.style.width = box.width;
      el.style.height = box.height;
      section.appendChild(el);
      passages.push({ id: passageId(block.text), index: passages.length, text: block.text, page: pageText.page, el });
      blocks.push({ text: block.text, el });
    }

    container.appendChild(section);
    sections.push({ page: pageText.page, section, canvas, blocks });
  }
  return { passages, sections };
}

export type RenderPageFn = (pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number) => Promise<void>;

/** The one method this file needs from an observer. */
export interface VisibilityObserver {
  disconnect(): void;
}

/** Reports a section entering or leaving the neighbourhood of the viewport. */
export type ObserveFactory = (sections: PageSection[], onChange: (page: number, visible: boolean) => void) => VisibilityObserver;

/** Reports that the sections' width changed. The implementation owns its own debounce. */
export type ResizeFactory = (sections: PageSection[], onResize: () => void) => VisibilityObserver;

export interface PageRenderer {
  /** The pages whose canvas currently holds pixels, ascending. */
  rendered(): number[];
  destroy(): void;
}

export interface PageRendererDeps {
  sections: PageSection[];
  renderPage: RenderPageFn;
  observe?: ObserveFactory;
  onResize?: ResizeFactory;
  pixelRatio?: () => number;
}

const defaultObserve: ObserveFactory = (sections, onChange) => {
  if (typeof IntersectionObserver === 'undefined') return { disconnect: () => {} }; // jsdom: nothing is ever visible
  const byElement = new Map<Element, number>(sections.map((s) => [s.section, s.page]));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = byElement.get(entry.target);
        if (page !== undefined) onChange(page, entry.isIntersecting);
      }
    },
    { rootMargin: OBSERVER_ROOT_MARGIN },
  );
  for (const s of sections) io.observe(s.section);
  return { disconnect: () => io.disconnect() };
};

const defaultResize: ResizeFactory = (sections, onResize) => {
  if (typeof ResizeObserver === 'undefined') return { disconnect: () => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onResize, RESIZE_DEBOUNCE_MS);
  });
  // One section is enough: they all share the column's width, so a resize moves all of them at once.
  if (sections[0]) ro.observe(sections[0].section);
  return {
    disconnect: () => {
      if (timer !== undefined) clearTimeout(timer);
      ro.disconnect();
    },
  };
};

const defaultPixelRatio = (): number => Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

/** §5.3's lazy canvases. Draws a page as it nears the viewport, at most two at a time, and gives the
 * memory back once a page is far enough behind — everything else about the document (the overlays,
 * the panel, the judging) is untouched by any of it, because the overlays are positioned in
 * percentages and never move. */
export function mountPageRenderer(deps: PageRendererDeps): PageRenderer {
  const { sections, renderPage } = deps;
  const pixelRatio = deps.pixelRatio ?? defaultPixelRatio;
  const byPage = new Map(sections.map((s) => [s.page, s]));
  const visible = new Set<number>();
  /** page -> the section width it was drawn at. Its KEYS are "this canvas holds pixels". */
  const drawn = new Map<number, number>();
  const queue: number[] = [];
  const inFlight = new Set<number>();
  let destroyed = false;

  function distanceFromVisible(page: number): number {
    let best = Infinity;
    for (const v of visible) best = Math.min(best, Math.abs(v - page));
    return best;
  }

  /** Nothing is released while nothing is visible: at startup, before the first intersection callback
   * has said where the viewport is, every distance would be Infinity and every canvas would go. */
  function release(): void {
    if (visible.size === 0) return;
    for (const page of [...drawn.keys()]) {
      if (distanceFromVisible(page) <= RELEASE_PAGE_DISTANCE) continue;
      const entry = byPage.get(page);
      if (!entry) continue;
      // Zeroing both dimensions is what actually frees the backing store, and dropping the `drawn`
      // entry is what re-arms `enqueue` for the next approach.
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      drawn.delete(page);
    }
  }

  function enqueue(page: number): void {
    if (destroyed || drawn.has(page) || inFlight.has(page) || queue.includes(page)) return;
    queue.push(page);
    pump();
  }

  function pump(): void {
    while (!destroyed && inFlight.size < RENDER_CONCURRENCY && queue.length > 0) {
      const page = queue.shift();
      if (page === undefined) return;
      void draw(page);
    }
  }

  /** §5.3's render failure: the page keeps its place and its passages stay readable and judgeable
   * without a canvas. The overlay elements never change identity, so a judge still running is
   * unaffected — and a tag the panel had already appended is put back after the text. */
  function showText(entry: PageSection): void {
    entry.section.classList.add('jd-render-failed');
    for (const block of entry.blocks) {
      const tags = [...block.el.querySelectorAll('.jd-rtag')];
      block.el.textContent = block.text;
      block.el.classList.add('jd-block-text');
      for (const tag of tags) block.el.appendChild(tag);
    }
  }

  async function draw(page: number): Promise<void> {
    const entry = byPage.get(page);
    if (!entry) return;
    inFlight.add(page);
    const cssWidth = entry.section.clientWidth;
    try {
      await renderPage(page, entry.canvas, cssWidth, pixelRatio());
      if (!destroyed) drawn.set(page, cssWidth);
    } catch {
      if (!destroyed) showText(entry);
    } finally {
      inFlight.delete(page);
      pump();
    }
  }

  function onVisibilityChange(page: number, isVisible: boolean): void {
    if (destroyed) return;
    if (isVisible) {
      visible.add(page);
      enqueue(page);
    } else {
      visible.delete(page);
    }
    release();
  }

  /** The overlays are percentages, so a resize recomputes no geometry — only bitmaps, and only those
   * whose width really moved. Every DRAWN page is checked rather than only the strictly visible ones:
   * a drawn page is within RELEASE_PAGE_DISTANCE of the viewport by construction, and skipping it
   * would pin it at the old width forever, since a drawn page is never re-queued. */
  function onResized(): void {
    if (destroyed) return;
    for (const [page, width] of [...drawn]) {
      const entry = byPage.get(page);
      if (!entry) continue;
      const next = entry.section.clientWidth;
      if (width > 0 && Math.abs(next - width) <= RESIZE_WIDTH_CHANGE * width) continue;
      drawn.delete(page);
      enqueue(page);
    }
  }

  const visibility = (deps.observe ?? defaultObserve)(sections, onVisibilityChange);
  const resizes = (deps.onResize ?? defaultResize)(sections, onResized);

  return {
    rendered: () => [...drawn.keys()].sort((a, b) => a - b),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      queue.length = 0;
      visibility.disconnect();
      resizes.disconnect();
    },
  };
}
```

- [ ] **Step 6: Run the pages tests to make sure they pass**

Run: `pnpm vitest run tests/unit/extension/reader-pages.test.ts`
Expected: PASS — all sixteen cases.

- [ ] **Step 7: Move the old `render` tests out of the reader-page test**

In `tests/unit/extension/reader-page.test.ts`, delete the whole `describe('render', ...)` block (its behaviour now lives in `reader-pages.test.ts`), drop `render` from the import list, and drop the now-unused `PdfDoc` type import and the `BOX` constant Task 2 added. The file keeps only `arxivHtmlUrl`, `isFetchableUrl` and the status-text describes. Update its header comment's first paragraph to:

```ts
// Unit coverage for reader.ts's PURE pieces only (status text, URL/src validation, arXiv detection) —
// importing the module here never touches chrome.*, fetch or pdf.js, because `wireUp()` only runs when
// `typeof chrome !== 'undefined'` (see reader.ts's guard at the bottom), and this file never installs a
// chrome stub. The page it BUILDS is covered in reader-pages.test.ts; everything that loads, fetches,
// asks for a permission or judges is exercised end-to-end in tests/e2e/reading.spec.ts.
```

- [ ] **Step 8: Run it and typecheck**

Run: `pnpm vitest run tests/unit/extension/reader-page.test.ts && pnpm typecheck`
Expected: the reader-page suite PASSES; typecheck fails only if the `render` import was left behind.

- [ ] **Step 9: Add the `#back` link to the reader markup**

In `src/extension/reader/reader.html`, make the header's first child the back link (§4; it ships `hidden` so it never flashes on a picker-only reader before the script runs):

```html
    <header class="jd-head">
      <a id="back" class="jd-back" href="#" hidden>← Back to the PDF</a>
      <p id="source" class="jd-source"></p>
      <p id="arxiv-hint" class="jd-hint" hidden></p>
```

- [ ] **Step 10: Rewrite `reader.css`'s document rules**

In `src/extension/reader/reader.css`, replace everything from `main {` to the end of the file (i.e. the old `main`, `h1`, `.jd-heading`, `.jd-passage` and `.jd-page-mark` rules) with the following, and add the `.jd-back` rule just above it. The `.jd-page`/`.jd-block` rules are verbatim from §5.3; the column widens from 720 to 900 px because a rendered letter page at 720 px sets 10 pt body text at about 9 CSS px.

```css
.jd-back {
  display: inline-block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 12px;
}

main {
  max-width: 900px;
  margin: 0 auto;
  padding: 16px;
}

h1 {
  font-size: 22px;
  line-height: 1.3;
}

/* One rendered page. `aspect-ratio` is set inline from the page's own size (pages.ts), so the section
   reserves the right space before its canvas exists — which is what keeps the overlays in place and
   the scroll position stable while canvases are drawn and released underneath them. The white
   background is the paper, in either colour scheme. */
.jd-page {
  position: relative;
  margin: 0 0 24px;
  background: #fff;
  border: 1px solid var(--border);
}

.jd-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* Floated over the page rather than in the flow: in normal flow it would push the canvas out of a box
   whose height comes from `aspect-ratio`. */
.jd-page-mark {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 1;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--field-bg);
  font-size: 11px;
  color: var(--muted);
}

/* One passage, over the pixels it was extracted from. READER_CSS's .jd-hl and .jd-flash apply to these
   unchanged. The two dim rules outrank its .jd-dim by specificity on purpose: fading a transparent
   overlay would do nothing, so dimming a rendered page means VEILING it — 65 % white, the same 35 %
   visibility as HTML dimming, lifting to nothing on hover. */
.jd-block {
  position: absolute;
  box-sizing: border-box;
}

.jd-block.jd-dim {
  background: #fff !important;
  opacity: .65 !important;
}

.jd-block.jd-dim:hover {
  opacity: 0 !important;
}

.jd-block .jd-rtag {
  position: absolute;
  right: 0;
  top: -1.3em;
}

/* §5.3's render-failure fallback: the passage's own text, in the passage's own place on the page. */
.jd-block.jd-block-text {
  background: #fff;
  overflow: auto;
  font: 13px/1.4 system-ui;
  padding: 2px 4px;
}
```

- [ ] **Step 11: Rewrite `reader.ts` around one open document**

(a) In `src/extension/reader/reader.ts`, replace the import block (`render`, `passageId` and `loadPages` all go; `openPdf` and `pages.ts` come in):

```ts
import * as pdfjsLib from 'pdfjs-dist';
import { LEAD_MAX, TITLE_MAX, type DocContext } from '../../core/reading';
import { send } from '../messages';
import type { ArticlePassage } from '../reading/article';
import { openPdf, type OpenedPdf, type PdfAssets, type PdfjsLike } from '../reading/pdf-load';
import { pagesToBlocks, type PdfDoc } from '../reading/pdf-text';
import { mountReader, type ReaderHandle } from '../reading/reader-ui';
import { runReading } from '../reading/run';
import { mountPageRenderer, render, type PageRenderer } from './pages';
```

and amend the file header's third paragraph to point at the new home of `render`:

```ts
// The pure pieces below (status text, `isFetchableUrl`, `arxivHtmlUrl`) are exported and unit-tested
// directly (tests/unit/extension/reader-page.test.ts, jsdom, no chrome stub needed); the page they
// build lives in ./pages.ts and is tested the same way. Everything that touches chrome.*, fetch or
// pdf.js lives inside `wireUp`, called only when this is really running as the extension page.
```

(b) Delete the whole exported `render` function (it now lives in `./pages.ts`), and add this module-scope helper in its place:

```ts
/** §5.3's runtime assets, from the extension's own origin: the standard 14 fonts so a PDF set in Times
 * is not blank, the cmaps so CJK-encoded text extracts, the wasm decoders so JPX/JBIG2 images render.
 * A function rather than a constant because `chrome.runtime` does not exist when this module is merely
 * imported by a test. */
function pdfAssets(): PdfAssets {
  return {
    standardFontDataUrl: chrome.runtime.getURL('standard_fonts/'),
    cMapUrl: chrome.runtime.getURL('cmaps/'),
    cMapPacked: true,
    wasmUrl: chrome.runtime.getURL('wasm/'),
  };
}
```

(c) Inside `wireUp`, add the back link to the element lookups and replace the state block:

```ts
  const allowBtn = $<HTMLButtonElement>('allow');
  const fileEl = $<HTMLInputElement>('file');
  const docEl = $('doc');
  const backEl = $<HTMLAnchorElement>('back');

  const src = new URLSearchParams(location.search).get('src') ?? undefined;

  let bytes: ArrayBuffer | undefined;
  let sourceName = src ?? '';
  let handle: ReaderHandle | undefined;
  // The document stays OPEN for as long as it is on screen: its canvases are drawn from it on demand,
  // and Read re-judges it with a new focus without re-fetching, re-parsing or re-rendering (§5.3).
  let opened: OpenedPdf | undefined;
  let renderer: PageRenderer | undefined;
  let passages: ArticlePassage[] = [];
  let title = '';
```

(d) Add the back-link behaviour next to `renderHint`:

```ts
  /** §4. Only a reader that REPLACED something has something to go back to: a picker-only reader, or
   * one opened in a fresh tab from the popup's hint link, does not — and Chrome's own PDF viewer is
   * exactly one entry back in that tab's history, because `chrome.tabs.update` navigated it. */
  function renderBack(): void {
    backEl.hidden = !(src !== undefined && history.length > 1);
  }

  backEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    history.back();
  });
```

(e) Replace `read()` with the three functions below (everything above it — `setStatus`, `renderHint`, `offerPermission`, `fetchPdf` — is unchanged):

```ts
  /** Drops everything holding the current document: the panel, the canvases' observers, and the pdf.js
   * worker. Called before a new document is opened, so two are never alive at once. */
  async function closeDocument(): Promise<void> {
    handle?.destroy();
    handle = undefined;
    renderer?.destroy();
    renderer = undefined;
    passages = [];
    title = '';
    const previous = opened;
    opened = undefined;
    await previous?.destroy();
  }

  /** bytes -> an open document, rendered in place. Returns false, with the status already set, when
   * there is nothing to read. */
  async function openDocument(data: ArrayBuffer): Promise<boolean> {
    let doc: PdfDoc;
    try {
      // A COPY: pdf.js transfers the typed array it is given to its worker, which detaches the buffer.
      const pdf = await openPdf(data.slice(0), pdfjs, pdfAssets());
      opened = pdf;
      doc = pagesToBlocks(pdf.pages, pdf.metaTitle ?? fileNameOf(sourceName));
      const built = render(doc, pdf.pages, docEl);
      passages = built.passages;
      renderer = mountPageRenderer({
        sections: built.sections,
        renderPage: (n, canvas, cssWidth, pixelRatio) => pdf.renderPage(n, canvas, cssWidth, pixelRatio),
      });
    } catch (err) {
      // A corrupt file, a PDF pdf.js refuses without a password, or an HTML interstitial served at a
      // `.pdf` URL all reject here rather than resolving — caught so the status recovers instead of
      // sticking on "reading…" forever, and so the failure never escapes as an unhandled rejection.
      setStatus(parseErrorStatus(err), true);
      return false;
    }
    title = doc.title;
    if (passages.length === 0) {
      setStatus(NO_TEXT_STATUS, true);
      return false;
    }
    return true;
  }

  /** Mounts the panel over whatever is rendered and judges it. Opens the document first if it is not
   * open yet, so pressing Read again re-judges the SAME rendered pages with a new focus (§5.3): no
   * fetch, no re-parse, no re-render, and the canvases already drawn stay drawn. */
  async function read(): Promise<void> {
    handle?.destroy();
    handle = undefined;
    if (!opened) {
      const data = bytes;
      if (!data) return;
      setStatus('reading…');
      if (!(await openDocument(data))) return;
    }
    const ctx: DocContext = { title: title.slice(0, TITLE_MAX), lead: passages[0].text.slice(0, LEAD_MAX), source: sourceName };
    handle = mountReader(document, {
      passages,
      focus: focusEl.value,
      onClose: () => {
        handle = undefined;
      },
    });
    setStatus(''); // the panel owns the progress and the summary from here on
    await runReading({ handle, ctx, passages, send });
  }

  async function load(url: string): Promise<void> {
    setStatus('loading…');
    const data = await fetchPdf(url);
    if (!data) return;
    await closeDocument();
    bytes = data;
    sourceName = url;
    await read();
  }
```

(f) Replace the file-picker handler so a picked file also closes the previous document:

```ts
  fileEl.addEventListener('change', () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    void (async () => {
      // A picked file never touches the network at all, which is also the answer for file:// URLs:
      // the picker is how you read one. The picker itself is never disabled, so it stays usable after
      // a failure — pick again and this fires again.
      const data = await file.arrayBuffer();
      await closeDocument();
      bytes = data;
      sourceName = file.name;
      sourceEl.textContent = file.name;
      allowBtn.hidden = true;
      await read();
    })().catch((err: unknown) => setStatus(parseErrorStatus(err), true));
  });
```

(g) Call `renderBack()` from `init`, next to `renderHint()`:

```ts
  async function init(): Promise<void> {
    sourceEl.textContent = src ?? '';
    renderHint();
    renderBack();
```

- [ ] **Step 12: Typecheck and run the whole unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `reader.ts` is not unit-tested beyond its pure exports, so this is the compile gate for it; the e2e in Step 18 is what exercises it.

- [ ] **Step 13: Teach the chrome stub `tabs.update`**

In `tests/unit/extension/chrome-stub.ts`, add to the `ChromeStub` interface:

```ts
  /** Every `(tabId, url)` passed to `chrome.tabs.update`, oldest first — how a test sees the popup
   * replacing a PDF in the tab that was showing it rather than opening a new one. */
  updatedTabs(): Array<{ tabId: number; url: string }>;
```

inside `installChromeStub`, next to `const createdTabs: string[] = [];`:

```ts
  const updatedTabs: Array<{ tabId: number; url: string }> = [];
```

inside the `tabs` object, after `create`:

```ts
      async update(tabId: number, props: { url?: string }): Promise<{ id: number; url?: string }> {
        updatedTabs.push({ tabId, url: props.url ?? '' });
        return { id: tabId, url: props.url };
      },
```

and in the returned handle, next to `createdTabs`:

```ts
    updatedTabs: () => [...updatedTabs],
```

- [ ] **Step 14: Write the failing same-tab popup tests**

In `tests/unit/extension/popup.test.ts`, replace the existing test `'Read this PDF opens the reader page on the tab url, and the hint link opens it empty'` with these two:

```ts
    // --- Design addendum 2026-09-23 §4: the PDF is replaced where it is, not copied to a new tab ---

    it('Read this PDF replaces the PDF in its own tab; the hint link still opens a new one', async () => {
      const stub = withTabs([{ id: 7, url: 'https://example.test/paper.pdf' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-pdf').click();
      el<HTMLAnchorElement>(doc, 'open-reader').click();
      await flush();

      expect(stub.updatedTabs()).toEqual([
        { tabId: 7, url: `${EXTENSION_ORIGIN}/reader.html?src=${encodeURIComponent('https://example.test/paper.pdf')}` },
      ]);
      // Open the PDF reader has nothing to replace, so it keeps opening a tab of its own.
      expect(stub.createdTabs()).toEqual([`${EXTENSION_ORIGIN}/reader.html`]);

      doc.dispatchEvent(new Event('unload'));
    });

    it('Read this PDF with no tab id says so and navigates nothing', async () => {
      const stub = withTabs([{ url: 'https://example.test/paper.pdf' }]); // a URL but no id
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-pdf').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe("can't read this tab: no tab id");
      expect(el(doc, 'read-status').classList.contains('error')).toBe(true);
      expect(stub.updatedTabs()).toEqual([]);
      expect(stub.createdTabs()).toEqual([]);

      doc.dispatchEvent(new Event('unload'));
    });
```

- [ ] **Step 15: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts`
Expected: FAIL — `expected [] to deeply equal [ { tabId: 7, url: ... } ]` (the popup still calls `tabs.create`).

- [ ] **Step 16: Make **Read this PDF** navigate the tab it is looking at**

In `src/extension/popup/popup.ts`, replace the `openReader` helper with the three below (keep the placement, just above `fillStats`):

```ts
  /** The extension's own reader page, optionally pointed at a PDF. Not web-accessible: only the
   * extension can navigate to it (§10). */
  const readerUrl = (source?: string): string => chrome.runtime.getURL(`reader.html${source ? `?src=${encodeURIComponent(source)}` : ''}`);

  /** §4. **Read this PDF** REPLACES Chrome's PDF viewer in the tab that is showing it: that viewer is
   * a MIME-handler frame no content script can enter, so replacing it is the closest an extension can
   * get to drawing on it — and **Back to the PDF** in the reader's header puts it back.
   * `chrome.tabs.update` needs no permission at all for the extension's own page. */
  function readPdfInPlace(): void {
    if (tabId === undefined) {
      setReadStatus("can't read this tab: no tab id", true);
      return;
    }
    void chrome.tabs.update(tabId, { url: readerUrl(tabUrl?.href) });
  }

  /** **Open the PDF reader** has nothing to replace, so it keeps opening a tab of its own. */
  function openReader(): void {
    void chrome.tabs.create({ url: readerUrl() });
  }
```

and replace the two click handlers near the bottom:

```ts
  readPdfBtn.addEventListener('click', readPdfInPlace);
  openReaderEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    openReader();
  });
```

- [ ] **Step 17: Run the popup suite to make sure it passes**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts`
Expected: PASS — including Task 1's stale-build cases, which disable this same button.

- [ ] **Step 18: Rewrite the reader e2e flows**

In `tests/e2e/reading.spec.ts`, replace the test `'the reader page reads a PDF fetched from a host the manifest allows'` with:

```ts
test('the reader page renders a PDF in place and draws the highlights on it', async () => {
  // The e2e's patched manifest declares the fixture origin as a host permission, which is what the
  // reader page's "Allow access" button would otherwise have to ask for.
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent(`${FIXTURE_ORIGIN}/sample.pdf`)}`);

  // Exactly what make-sample-pdf.mjs draws: two pages, eight passages across them. Headings are drawn
  // on the canvas rather than overlaid, so there is no .jd-heading any more.
  await expect(page.locator('.jd-page')).toHaveCount(2);
  await expect(page.locator('.jd-block')).toHaveCount(8);
  await expect(page.locator('.jd-page-mark')).toHaveCount(2);
  await expect(page.locator('h1')).toHaveText('Sample Paper');

  // Headless Chromium really rasterises: the first page's canvas holds device pixels once its section
  // is near the viewport, which with a 150 % root margin is immediately.
  await expect
    .poll(() => page.locator('.jd-page').first().locator('canvas').evaluate((c) => (c as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
  await expect(page.locator('.jd-page').first()).not.toHaveClass(/jd-render-failed/);

  // The method paragraph is the one MOCK_FIXTURES pins to core 0.95; only highlights are listed, so
  // its row in the panel is also the proof that its overlay carries jd-hl.
  const highlights = await page.locator('.jd-block.jd-hl').count();
  expect(highlights).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#jd-reader ol li')).toHaveCount(highlights);
  await expect(page.locator('#jd-reader ol li', { hasText: 'The method encodes each input token as a vector' })).toHaveCount(1);
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);
  await expect(page.locator('#jd-reader p.error')).toHaveText('');

  // Clicking a row takes you to its overlay; the flash is the half of that a headless run can assert.
  await page.locator('#jd-reader ol li').first().click();
  await expect(page.locator('.jd-block.jd-flash')).toHaveCount(1);

  // A reader opened in a fresh tab has nothing to go back to.
  await expect(page.locator('#back')).toBeHidden();

  await page.close();
});

test('Read this PDF replaces the PDF in the tab that was showing it', async () => {
  const pdfUrl = `${FIXTURE_ORIGIN}/sample.pdf`;
  const tab = await ext.context.newPage();
  // Chromium's own viewer displays the file. A build that downloaded it instead would reject here and
  // leave the tab elsewhere, which the next line reports plainly rather than three assertions later.
  await tab.goto(pdfUrl).catch(() => undefined);
  expect(tab.url()).toBe(pdfUrl);

  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?jd-tab=${encodeURIComponent(pdfUrl)}`);
  const pagesBefore = ext.context.pages().length;

  await popup.locator('#read-pdf').click();

  // The SAME tab navigates to the reader: no new page is opened anywhere in the context.
  await expect.poll(() => tab.url()).toMatch(/^chrome-extension:\/\/[a-p]+\/reader\.html\?src=/);
  expect(ext.context.pages()).toHaveLength(pagesBefore);
  await expect(tab.locator('.jd-block')).toHaveCount(8);
  await expect(tab.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);
  // ...and Chrome's viewer is exactly one entry back.
  await expect(tab.locator('#back')).toBeVisible();

  await popup.close();
  await tab.close();
});
```

In the test `'the reader page reads a PDF picked from disk'`, replace its four document assertions with:

```ts
  // Same assertions as the URL path: a picked file goes through the identical open/render/judge flow.
  await expect(page.locator('.jd-block')).toHaveCount(8);
  await expect(page.locator('.jd-page')).toHaveCount(2);
  await expect(page.locator('.jd-page-mark')).toHaveCount(2);
  await expect(page.locator('h1')).toHaveText('Sample Paper');
  await expect(page.locator('#jd-reader ol li')).not.toHaveCount(0);
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);
  await expect(page.locator('#back')).toBeHidden();
```

And in the last two tests (`'a PDF that fails to parse …'` and `'an empty or non-http(s) src …'`), change every `.jd-passage` locator to `.jd-block` — four occurrences in total, with the same counts (`0`, then `8` after the picker).

- [ ] **Step 19: Build and run the e2e**

Run: `pnpm build && pnpm test:e2e`
Expected: PASS — six reader tests plus the two HTML reading tests and the asset test.

- [ ] **Step 20: Update the README (§7)**

In `README.md`'s **Reading mode** section, replace the `**On a PDF.**` paragraph with:

```markdown
**On a PDF.** The popup swaps in **Read this PDF** when the tab looks like one (a `.pdf` path, or an
arXiv `/pdf/` URL). It replaces Chrome's PDF viewer **in that same tab** with jev-duo's own reader,
which renders the same pages with pdf.js and draws the highlights straight onto them: a highlighted
passage gets the left rule and the `<kind> · <confidence>` tag over the text it was extracted from,
and filler is veiled in white that lifts when you hover it. **← Back to the PDF** in the header
returns you to Chrome's viewer. (Chrome does not let any extension script its built-in PDF viewer —
it is a MIME-handler frame no content script can enter — so replacing it is the closest possible
thing.) **Open the PDF reader** in the hint line opens the reader empty, in a new tab. A host that
does not send permissive CORS headers needs its own permission: the reader says
`can't fetch this file from <origin>` and offers **Allow access to <origin>**, which asks Chrome for
that one origin. **Open a PDF from your computer** reads a local file instead, which never touches
the network at all. For an arXiv PDF the reader points at the HTML version of the same paper, which
has real paragraphs and reads better. Pages are rendered as you reach them and released again once
you are well past them, so a long PDF does not sit in memory all at once; if a page cannot be
rendered, its passages are shown as text in place so they stay readable and judgeable.
```

In the same section, replace the `**Limits.**` paragraph's last sentence and add the error copy:

```markdown
**Limits.** Reading is explicit, per document, and never runs on its own. Judgments use fixed
thresholds — the **Strictness** slider is a feed-mode control and does not apply. A passage whose
judgment fails or times out is shown plain rather than dimmed, and when anything failed the panel
prints a second line naming the last error. Documents are capped at 600 passages.

**After updating an unpacked install.** Chrome keeps the old service worker running until you reload
the extension, and the old one has no idea what reading mode is — so the popup disables **Read this
page**/**Read this PDF** and says `reload the extension at chrome://extensions (↻) to finish
updating`. If a read got through anyway, the panel says
`the extension was updated — reload it at chrome://extensions (↻) and read again` instead of a bare
error count. Reload at `chrome://extensions` with the ↻ button and read again.
```

And in **Known limits**, extend the reading-mode bullet:

```markdown
- **Reading mode does not do everything.** No scanned PDFs (a page with no text layer needs OCR,
  which jev-duo does not do — the reader says so rather than showing an empty document), no `file://`
  URLs (use **Open a PDF from your computer**), no reading on page load, no figures, math or tables
  (a table is flattened into one run of text before it is judged, when it is not excluded outright),
  no comment filtering, no DOCX or EPUB, and no Firefox. There is no text selection on a rendered PDF
  page: the page is a picture with passage overlays on it, not a text layer. The strictness slider
  does not apply to reading: it uses fixed thresholds.
```

- [ ] **Step 21: Run the whole gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 22: Commit**

```bash
git add src/extension/reader/pages.ts src/extension/reader/reader.ts src/extension/reader/reader.html src/extension/reader/reader.css src/extension/popup/popup.ts tests/unit/extension/chrome-stub.ts tests/unit/extension/reader-pages.test.ts tests/unit/extension/reader-page.test.ts tests/unit/extension/popup.test.ts tests/e2e/reading.spec.ts README.md
git commit -m "$(cat <<'EOF'
feat(reading): read a PDF where it is, on the pages themselves

Read this PDF now replaces Chrome's viewer in the tab that was showing the
file, and the reader renders the same pages with pdf.js: canvases drawn as
they near the viewport (two at a time, released eight pages behind) with one
absolutely-positioned overlay per passage, so highlights and dimming land on
the text they were extracted from. Back to the PDF returns to Chrome's
viewer; a page that cannot be rendered shows its passages as text instead.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

### 1. Spec coverage

| Spec section | Requirement | Task | Where |
| --- | --- | --- | --- |
| §1 Goal | the three field-test failures | 1, 3 | the plan's Goal; no code of its own |
| §2 Principles | same tab, same document | 3 | Step 16 (`chrome.tabs.update`), Steps 9/11 (`#back`) |
| §2 Principles | errors carry their reason | 1 | Steps 3, 7, 13 |
| §2 Principles | 65 % white veil, lifting on hover; no new permissions | 3 | Step 10 (`.jd-block.jd-dim` / `:hover`); Global Constraints |
| §3.1 | `ReadingJudge` `lastError`, capped at 200 | 1 | Steps 1–4 |
| §3.1 | `readPassages` reply carries it | 1 | Steps 7, 9, 10 |
| §3.1 | `runReading` summary + `finish(summary)` | 1 | Steps 5–8 |
| §3.2 | `<p class="error">`, `last error: …`, `STALE_BACKGROUND_HINT`, `errors without a message` | 1 | Steps 11–14 |
| §3.3 | `buildId` in `scripts/build.mjs`, `define: { __JD_BUILD__ }` | 1 | Steps 19–20 |
| §3.3 | `src/extension/build-id.ts` | 1 | Steps 15–18 |
| §3.3 | `getState.build` | 1 | Step 23 |
| §3.3 | popup disables both buttons, `STALE_POPUP_STATUS`, failed `getState` changes nothing | 1 | Steps 21–24 |
| §3.4 | the `@live-jev` extension test | 1 | Step 25 |
| §4 | `chrome.tabs.update(tabId, { url })` for **Read this PDF**; `tabs.create` kept for **Open the PDF reader**; no-tab-id status | 3 | Steps 14–17 |
| §4 | `<a id="back">← Back to the PDF</a>`, `history.back()`, shown only with `src` and `history.length > 1` | 3 | Steps 9, 11(d) |
| §5.1 | `Box`, `PageText.originX/originY`, line box, block union, headings carry boxes, `toPercentBox` with clamping | 2 | Steps 1–4 |
| §5.2 | `PdfAssets`, `OpenedPdf`, `openPdf`, `renderPage`, `destroy` on the loading task, `loadPages` as a wrapper | 2 | Steps 7–10 |
| §5.3 | sections with `aspect-ratio`, page marks, canvases, `.jd-block` overlays as the passages' `el`, `MAX_PASSAGES` | 3 | Steps 1, 5 |
| §5.3 | `reader.css` rules (`.jd-page`, `.jd-block`, `.jd-dim`, `:hover`, `.jd-rtag`, `.jd-block-text`) | 3 | Step 10 |
| §5.3 | lazy canvases: `150% 0px`, 2 in flight FIFO, release beyond 8 pages, re-render on approach | 3 | Steps 3, 5 |
| §5.3 | resize re-render at 25 %, `ResizeObserver` debounced 300 ms | 3 | Steps 3, 5 |
| §5.3 | render failure → `jd-render-failed` + `jd-block-text`, same `el` identity | 3 | Steps 3, 5 |
| §5.3 | observer and renderer injectable | 3 | Steps 3, 5 (`ObserveFactory`/`ResizeFactory`/`pixelRatio`) |
| §5.3 | Read re-runs on the same opened document; the previous one is destroyed | 3 | Step 11(e) |
| §5.3 Assets | the three folder copies, one-line missing-folder error, reader passes the four options | 2 (build), 3 (reader) | T2 Steps 11–13; T3 Step 11(b) |
| §6 unit | `pdf-text.ts` boxes and `toPercentBox` | 2 | Step 1 |
| §6 unit | `pdf-load.ts` legacy `openPdf`, fake `renderPage` (1600 × 2071), rejecting render | 2 | Step 7 |
| §6 unit | reader page: sections, overlays, render failure, fake observer, 2 in flight | 3 | Steps 1, 3 |
| §6 unit | `run.ts` `lastError` (batch / reply / absent) | 1 | Step 5 |
| §6 unit | `reader-ui.ts` four `finish` cases | 1 | Step 11 |
| §6 unit | popup: stale build, equal build, `tabs.update`, `tabs.create` | 1, 3 | T1 Step 21; T3 Step 14 |
| §6 unit | `build-id.ts` is `'dev'` | 1 | Step 15 |
| §6 unit | build: the three folders | 2 | Steps 7 (sources + script) and 13 (dist) — see Decision 5 |
| §6 e2e | `?src=` flow: 2 `.jd-page`, 8 `.jd-block`, canvas `width > 0`, a highlight, row click, `#back` hidden | 3 | Step 18 |
| §6 e2e | same-tab flow: URL becomes the reader, page count unchanged, 8 `.jd-block`, `#back` visible | 3 | Step 18 |
| §6 e2e | picker flow with `.jd-block` | 3 | Step 18 |
| §6 e2e | live | 1 | Step 25 |
| §7 Docs | README: same tab, **Back to the PDF**, the `last error` line, the reload hint, "no text selection" | 3 | Step 20 |
| §8 Non-goals | nothing to build | — | — |

No gaps. Two spec items are implemented in a different place than §6's headings imply, both recorded under Decisions: the build assertion is split across vitest and the e2e (Decision 5), and `render` moved to `pages.ts` (Decision 1).

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate error handling`, `add validation`, `handle edge cases`, `Similar to Task N`, and steps that describe without showing. None found. Every code step carries the literal TypeScript, HTML, CSS, JS or test code to write; every run step carries the exact command and the expected pass/fail text. The two places that say "replace X with Y" (`reader.css`'s tail, the popup's `openReader`) give the full replacement text, not a description of it.

### 3. Type consistency

- `lastError` is spelled the same in all five places it travels: `ReadingRun.lastError?: string` (T1 Step 3) → the `readPassages` response (T1 Step 7) → `runReading`'s summary (T1 Step 7) → `ReaderHandle.finish(summary)` (T1 Step 7) → `lastErrorLine(lastError: string | undefined)` (T1 Step 13). The panel test, the run test and the background test all use that one name.
- `BUILD_ID` (T1 Step 17) is imported by `background.ts` (Step 23), `popup.ts` (Step 23) and `popup.test.ts` (Step 21); `getState.build` is `string` on all three sides.
- `STALE_BACKGROUND_HINT` (panel, `reader-ui.ts`) and `STALE_POPUP_STATUS` (popup) are distinct constants with distinct strings, and neither is referenced from the other module.
- `PageText` gains `originX`/`originY` in T2 Step 3; every construction site is updated in the same task (`openPdf` in Step 9, the `page()` test helper in Step 1) and T3's `letter()` helper builds the same shape.
- `Block.box: Box` (T2 Step 3) is produced by `draftsOfPage`/`pagesToBlocks` and consumed by `render` via `toPercentBox(block.box, pageText)` — and `toPercentBox`'s second parameter type `{ width; height; originX; originY }` is structurally satisfied by `PageText`, which is how T3 passes one straight in.
- `OpenedPdf.renderPage(pageNumber, canvas, cssWidth, pixelRatio)` (T2 Step 9) matches `RenderPageFn` (T3 Step 5) argument for argument, which is what makes T3 Step 11(e)'s one-line adapter type-check.
- `render(doc, pages, container): RenderedDoc` returns `{ passages, sections }`; `mountPageRenderer({ sections, renderPage, observe?, onResize?, pixelRatio? })` takes `sections` — the same `PageSection[]`, with `page`/`section`/`canvas`/`blocks` used identically in the implementation and in every test.
- `ObserveFactory` is `(sections, onChange: (page, visible) => void)` and `ResizeFactory` is `(sections, onResize: () => void)`; the fakes in T3 Step 1 and the inline `onResize` in T3 Step 3 match both arities.
- `ChromeStub.updatedTabs()` (T3 Step 13) returns `Array<{ tabId: number; url: string }>`, which is exactly what T3 Step 14 asserts against.
- Nothing in Task 3 references a symbol Task 2 did not export, and nothing in Task 2 references a symbol Task 1 did not export; Task 1 is self-contained.

