# jev-duo — selective highlights and arXiv in place (design addendum)

Date: 2026-09-23
Status: approved for implementation (owner delegated all design decisions)
Extends: `2026-09-22-reading-mode-design.md`, `2026-09-23-reading-in-place-design.md`

## 1. Goal

Two field-test findings, one round:

1. On a news article (TechCrunch, 11 paragraphs) every paragraph was highlighted. Measured with the
   real provider: every `core` probability fell between 0.86 and 0.94, so all eleven crossed the fixed
   0.7 line. On an article almost every paragraph *is* the document's own content; an absolute
   threshold cannot select. Highlights must be relative — the top share of a document — and the
   judge must be asked directly about salience.
2. On an arXiv PDF, **Read this PDF** sent the tab to the extension's own reader page. The owner wants
   to work on the web page itself. arXiv publishes an HTML version of nearly every paper (even
   hep-th/9901001 has one), so the same tab can go to that page and the ordinary in-page reader runs
   there — no extension UI at all. The rendered PDF reader stays for every other PDF, because Chrome
   lets no extension script its built-in viewer.

## 2. Selective highlights

### 2.1 Questions (`src/core/reading.ts`)

`readingQuestions(focus)` returns, in this order:

1. `{ id: 'core', type: 'noul', statement: CORE_STATEMENT }` (unchanged).
2. `{ id: 'key', type: 'noul', statement: KEY_STATEMENT }` where
   `KEY_STATEMENT = "This passage is one of the few a reader skimming the document for its essentials must not miss — a central claim, a key result or number, a decisive quotation, or the conclusion — rather than a supporting, connective, or illustrative passage."`
3. only when `focus.trim() !== ''`: the `focus` question (unchanged).
4. the `kind` choice question (unchanged).

`ReadingVerdict` gains `key: number` (the `key` answer's `p`, 0.5 when missing). `decideReading`
still fills `core`, `key`, `focus?`, `kind?` and a *provisional* `verdict` by the old absolute
rule; nothing downstream shows a provisional verdict any more (§2.3).

### 2.2 Ranking (`src/core/reading.ts`)

```ts
export const HIGHLIGHT_SHARE = 0.25;   // of the judged passages, rounded up, at least 1
export const DIM_SHARE = 0.2;          // of the judged passages, rounded down
export const HIGHLIGHT_FLOOR = 0.5;    // a passage below this on its ranking score is never highlighted
export const DIM_CEILING = 0.5;        // a passage above this on `core` (or `focus`) is never dimmed
export function rankReading(verdicts: ReadingVerdict[], hasFocus: boolean): ReadingVerdict[]
```

- Input: every verdict of one document (any order). Output: new objects in the same order with
  `verdict` reassigned; `error: true` verdicts stay `plain` and take no part in the ranking.
- Ranking score `s = hasFocus ? focus ?? 0 : key`.
- **highlight**: sort the non-error verdicts by `s` descending (ties by `core` descending, then by
  input order); the first `Math.max(1, Math.ceil(n × 0.25))` of them whose `s ≥ 0.5` are
  `highlight`. When no verdict reaches the floor, nothing is highlighted.
- **dim**: among the non-highlighted, non-error verdicts, sort by `core` ascending (ties by input
  order); the first `Math.floor(n × 0.2)` whose `core ≤ 0.5` — and, when `hasFocus`, whose
  `focus ≤ 0.5` — are `dim`.
- everything else is `plain`. `p` is set to `s` for highlights, to `core` for dims and plains.
- Worked cases (tests): eleven passages with `key` 0.86…0.94, `core` similar → 3 highlights, 0 dims;
  eleven with `key` all 0.2 → 0 highlights, 2 dims where `core ≤ 0.5`; one passage with `key` 0.9 →
  1 highlight; one with `key` 0.3 → plain; focus set, `focus` 0.9/0.6/0.1/0.1 over four passages →
  1 highlight (0.9), dims only among the 0.1s with `core ≤ 0.5`; an `error: true` verdict never
  counted in `n` and never highlighted or dimmed; ordering preserved and objects not aliased.

### 2.3 Two phases (`src/extension/reading/run.ts`, `reader-ui.ts`)

`runReading` no longer applies verdicts as batches return. It collects them, keeps
`setProgress(judged, total)` running, and when the last batch is in it calls
`rankReading(all, hasFocus)` (`hasFocus` = the reply's `focus` is non-empty) and applies every
ranked verdict, then `finish`. A destroyed handle still stops the loop. `ReaderHandle.apply`
is unchanged (first verdict per id wins) because each id is now applied exactly once.
The panel's progress line reads `N of M judged` until the end, then the summary; the list fills
in one go. Tests: the run test asserts nothing is applied before the last batch, the ranked set
after, and the summary's counts.

### 2.4 Strictness (popup)

The reading section gains one line under the focus box:
`<label class="jd-field">Highlight <select id="highlight-share"><option value="0.15">the top 15%</option><option value="0.25" selected>the top 25%</option><option value="0.4">the top 40%</option></select></label>`.
`Settings.highlightShare: number` (default 0.25, saved via `setSettings`); the background passes it
in the `readPassages` reply as `highlightShare`, and `runReading` hands it to `rankReading` as an
optional third argument `share` (default `HIGHLIGHT_SHARE`). The feed-mode strictness slider still
does not apply to reading.

## 3. arXiv in place

### 3.1 Popup

`arxivId(url: URL): string | undefined` (new `src/extension/arxiv.ts`): for `hostname ===
'arxiv.org'` and a pathname of `/pdf/<id>`, `/abs/<id>` or `/html/<id>` — `<id>` being everything
after the prefix minus a trailing `.pdf` (new-style `2401.00001v2` and old-style `hep-th/9901001`
both work) — returns `<id>`; otherwise `undefined`. Exported for tests.

Button matrix, in this order of precedence:

- `arxivId(tabUrl)` set and the path is `/pdf/…` or `/abs/…` → **Read this paper** (`#read-arxiv`,
  shown), **Read this page** and **Read this PDF** hidden; hint under the buttons:
  `opens the HTML version of this paper on arxiv.org and reads it there`.
- an `/html/…` arXiv page is an ordinary web page: **Read this page** as before.
- otherwise unchanged.

Click: sends `{ type: 'readArxiv', tabId, id, pdfUrl: 'https://arxiv.org/pdf/' + id }` and shows
`opening the HTML version…`; the reply sets the status to `reading N passages` (state `reading`)
or `no HTML version — opening the PDF reader` (state `fallback`), or `can't read this tab: <error>`.

### 3.2 Background (`src/extension/background.ts`, `src/extension/arxiv.ts`)

`readArxiv { tabId, id, pdfUrl }` (popup only; refused for content-script senders like
`enableSite`):

1. `chrome.tabs.update(tabId, { url: 'https://arxiv.org/html/' + id })`.
2. Wait for `chrome.tabs.onUpdated` to report `status === 'complete'` for that `tabId` (listener
   removed afterwards; 20 s timeout → `{ ok: false, error: 'the arXiv page did not finish loading' }`).
3. `chrome.scripting.executeScript({ target: { tabId }, files: ['read-page.js'] })`. The popup's
   click granted `activeTab` for the tab, and Chrome keeps that grant across a same-origin navigation
   (arxiv.org → arxiv.org), so no host permission is needed.
4. Result `{ state: 'started', passages: N }` → reply `{ ok: true, type: 'readArxiv', state: 'reading', passages: N }`.
   Result `no-article` (arXiv's placeholder for a paper without an HTML version, or any page with too
   few paragraphs) → `chrome.tabs.update(tabId, { url: chrome.runtime.getURL('reader.html?src=' + encodeURIComponent(pdfUrl)) })`
   and reply `{ state: 'fallback' }`. An `executeScript` rejection → `{ ok: false, error }`.

The whole sequence runs in the background so it completes even if the popup closes after the click.

### 3.3 Reader page

Unchanged, except its arXiv hint now reads
`arXiv also publishes an HTML version of most papers: <a>open it</a> — the popup's Read this paper does that in one click.`

## 4. Tests

- `reading.test.ts`: the `key` question's position and text; `decideReading` fills `key`; every
  `rankReading` case in §2.2 plus the `share` argument (0.15 over 11 → 2 highlights; 0.4 → 5).
- `run.test.ts`/`reader-ui.test.ts`: two-phase behaviour (§2.3); `highlightShare` passed through.
- `background.test.ts`: `readPassages` reply carries `highlightShare`; `readArxiv` happy path with a
  chrome stub whose `tabs.update` resolves, `tabs.onUpdated` fires `complete` for the tab, and
  `scripting.executeScript` returns `started` → `reading`; the `no-article` result → second
  `tabs.update` to the reader URL and `fallback`; the timeout error; refusal for a content-script
  sender.
- `arxiv.test.ts`: `arxivId` over `/pdf/1706.03762`, `/pdf/1706.03762v7.pdf`, `/abs/2401.00001`,
  `/html/hep-th/9901001`, `/pdf/hep-th/9901001v2.pdf`, a non-arXiv host, `/list/cs`.
- `popup.test.ts`: the button matrix for `/pdf/`, `/abs/`, `/html/` and a non-arXiv URL; the click
  message shape and the three statuses; the `highlight-share` select persists.
- E2E (`reading.spec.ts`): the article fixture (21 passages) now yields exactly
  `Math.ceil(21 × 0.25) = 6` highlights with mock fixtures that give the pinned passages the highest
  `key` (seed `key` alongside `core` in the fixture map); the panel list has 6 rows.
- `@live-jev` (`reading-live.spec.ts`, `LIVE=1` + key): the TechCrunch-shaped case cannot be fetched
  offline, so use the article fixture through the extension with the real provider and assert
  `1 ≤ highlights ≤ 6` and `dims ≤ 4`.
- The arXiv flow itself needs arxiv.org and `activeTab`, which the harness cannot grant; it is
  covered by the background unit tests above and a manual check.

## 5. Docs

README: the reading-mode section explains that highlights are the top share of a document (default
25 %, selectable), that dims are the least substantive fifth, and the arXiv one-click flow
(**Read this paper** on an arXiv abstract or PDF page opens the HTML version in the same tab and reads
it there; papers without an HTML version fall back to the rendered PDF reader).

## 6. Non-goals

Per-site heuristics beyond arXiv; changing the feed-mode slider; streaming provisional highlights
before the ranking; ranking across documents.
