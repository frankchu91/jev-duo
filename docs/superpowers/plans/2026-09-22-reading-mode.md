# Reading mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read one long-form document with the user — highlight the passages that carry the substance (or answer a typed question), dim the filler, and list the highlights — on an HTML page or a PDF, one Jev call per passage and no LLM at all.

**Architecture:** Both sources reduce to a `Passage[]` plus a `DocContext`. `src/core/reading.ts` owns the question template and the highlight/dim/plain decision; `src/core/reading-judge.ts` runs them six at a time behind an LRU cache. HTML passages come from `src/extension/reading/article.ts` (paragraph candidates + a mass-based container descent); PDF passages come from `pdf-text.ts` (lines → bands → blocks, pdf.js-free) fed by `pdf-load.ts` (pdf.js injected, so the browser build and the Node legacy build share the code). One reader UI (`reading/reader-ui.ts`) and one judging loop (`reading/run.ts`) serve both the script injected into a page (`read-page.ts`) and the extension's own PDF page (`reader/reader.ts`). The background gains a single `readPassages` handler; the manifest is unchanged.

**Tech Stack:** as the main plan (TypeScript 5.9 strict ESM, pnpm, vitest 5 + jsdom, Playwright, esbuild 0.28, Manifest V3), plus `pdfjs-dist@^6.3.289`.

**Spec:** `docs/superpowers/specs/2026-09-22-reading-mode-design.md` (extends `2026-09-20-jev-duo-design.md`, `2026-09-21-generic-sites-design.md`).

## Decisions

Where the spec is silent, contradicts itself, or names something the real code does not have, this is what the plan does and why. Nothing here changes a threshold, a copy string or an exported name the spec fixes.

1. **`decideReading`'s dim rule follows §4.2, not §12's table.** §4.2 says `dim` when `core <= 0.3 && (!hasFocus || focus <= 0.3)`; §12's table says `(focus .59, core .2) dim`, which §4.2 makes `plain`. The algorithm section wins (the focus guard is deliberate: a passage that is half-relevant to your question must not be dimmed). That one row becomes `plain` and a new row `(focus .2, core .2) → dim` keeps the with-focus dim path covered.
2. **Running-header threshold gets a floor of 2 pages.** §6.1.4's "≥ half the pages when the document has fewer than 6" makes the threshold 1 for a 2-page document, which would drop every line of `sample.pdf` — including its title — and fail §12's own PDF test. Threshold = `pages.length >= 6 ? 3 : Math.max(2, Math.ceil(pages.length / 2))`. A single-page document therefore never has a running header, which is correct: one page cannot show a repetition.
3. **`visibleText`/`collapsedText` move to `src/extension/dom-text.ts`.** They are module-private in `adapters/generic.ts`, and §5.1 defines the article candidate rules as "the generic adapter's `visibleText` rules". The two functions (plus `isHidden` and the `textWalks` counter the generic-adapter test reads) move verbatim; `generic.ts` imports them and `__generic.textWalks()`/`__generic.reset()` delegate to `__domText`, so every existing generic-adapter test keeps passing. Importing the feed adapter into the reader would have bundled the adapter's cache and heuristics into the injected script for two helpers.
4. **`sha256Hex` is exported from `src/core/cache.ts`.** §4.3 wants "the same hashing helper the evaluator uses", but `verdictKey(pack, item)` is pack-shaped. `verdictKey` is refactored to call a new exported `sha256Hex(input: string): Promise<string>`; its own behaviour is unchanged.
5. **`semaphore` is exported from `src/core/evaluator.ts`.** The judge needs the identical counting semaphore; copying 15 lines would give reading mode a second implementation to keep in step.
6. **`ReaderHandle` gains `setFocus(focus: string): void`.** §8.1 requires the panel to mount synchronously (the completion value is set in the same tick), but §9 makes the background the owner of `Settings.focus` and its reply is what carries it. `runReading` calls `setFocus` once, from the first reply. The PDF reader page reads `Settings.focus` itself and mounts with the real value, so nothing there flickers.
7. **`src/extension/reading/run.ts` is a new file.** §6.3 says the PDF page "then runs the shared reader flow (§8)"; the batching, the verdict application and the summary are that flow, and a second copy in `reader.ts` would drift from `read-page.ts`. `reader-ui.ts` stays pure DOM: `run.ts` is the only reading file that touches `send`.
8. **`articleCandidates(doc)` is exported from `article.ts`.** §8.1's `no-article` result carries "<candidate count>", which `extractArticle`'s `Article | undefined` cannot report.
9. **`passageId(text)`, `TITLE_MAX` and `LEAD_MAX` are exported from `reading.ts`.** §3 fixes the id formula and the 200/600 caps but names no helper for them; three call sites (article, the PDF reader, the e2e) need the id formula and two need the caps.
10. **`PdfjsLike`'s document/page types are structural and validated at runtime.** §6.2 names only `PdfjsLike` and `loadPages`. `PdfDocumentLike`/`PdfPageLike` are declared as the narrowest shape both pdf.js builds satisfy (`items: unknown[]`, `getMetadata(): Promise<unknown>`), narrowed in `toTextItem`/`metaTitleOf`, so neither build's `.d.ts` can break `pnpm typecheck`. `loadPages` also calls the optional `destroy()` in a `finally` so the Node tests leave no live worker behind.
11. **The panel's internal CSS is a module-private `PANEL_CSS`.** §8.2 fixes `READER_CSS` as the exported document-level sheet (`jd-hl`, `jd-dim`, `jd-flash`, `jd-rtag`, `#jd-reader`); the shadow root's own stylesheet is unspecified, so it stays private rather than being bolted onto the exported constant.
12. **The `@live-jev` reading test also requires `LIVE=1`.** §12 says "skipped without a key", but `playwright.config.ts` always loads `.env`, so a key-only guard would make a plain `pnpm test:e2e` spend money. It follows the existing pattern in `extension.spec.ts`: `test.skip(!LIVE)` then `test.skip(!JEV_KEY)`. Its three passage texts are literals in the test file, identical to the ones `make-sample-pdf.mjs` draws in Task 3 — Task 1 must not depend on Task 3.
13. **`package.json` `engines.node` stays `>=20`.** `pdfjs-dist@6` wants Node ≥ 22.13, but it is only used by the extension build and the tests, never by the published CLI bundle. CI already runs Node 22 (`.github/workflows/ci.yml`), and this machine runs 23.11.
14. **List snippets end in `…` only when truncated.** §8.2's `<kind> · <first 80 chars>…` does not say what a 50-character passage looks like; appending an ellipsis to untruncated text would be a lie.

## Global Constraints

- `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` green after every task; every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as its last line.
- Feed mode is untouched: no adapter, no fixture, no rule/keep/strictness/arbiter behaviour changes. Reading never reads `Settings.strictness` (fixed thresholds, spec §13) and never adds to `DuoStats` (spec §9).
- Reading constants (exact): `MIN_PASSAGE_CHARS = 40`, `MAX_PASSAGES = 600`, `JUDGE_TEXT_MAX = 1500`, title ≤ 200 chars, lead ≤ 600 chars, `T_HIGHLIGHT_CORE = 0.7`, `T_HIGHLIGHT_FOCUS = 0.6`, `T_DIM = 0.3`, concurrency 6, timeout 10_000 ms, cache size 2000, batch size 12.
- Ids: `id = 'rd:' + fnv1a(text.slice(0, 300))`. Question ids are exactly `core`, `focus`, `kind`; `KIND_OPTIONS = ['claim', 'method', 'result', 'background', 'boilerplate']`; `CORE_STATEMENT` is copied verbatim from spec §4.1.
- Article gates (exact): candidate = a `p` under `body` with ≥ 40 chars of collapsed visible text and no ancestor matching `nav, header, footer, aside, form, figure, figcaption, table, pre, code, [role="navigation"], [role="complementary"], [contenteditable]`; container descent while the largest child holds ≥ 80 % of the mass; an article needs ≥ 6 passages and ≥ 1500 chars total.
- PDF geometry constants (exact): line tolerance 2 pt, header tolerance 3 pt, body size rounded to 0.5 pt, full-width share 0.6, gap factor 1.45, size step 1 pt, heading factor 1.15 with ≤ 120 chars, title ≥ 8 chars, page numbers ≤ 4 chars of digits or roman numerals.
- Fail open everywhere: a passage whose judgment errors or times out is shown plain (`{ verdict: 'plain', p: 0.5, core: 0.5, error: true }`) and counted in `errors`; a document is never blanked; nothing is ever hidden (dimmed passages stay at 35 % opacity and restore on hover).
- No new permissions and no manifest change. `activeTab` + `scripting` inject `read-page.js`; `reader.html` is opened with `chrome.runtime.getURL` and is not web-accessible; pdf.js runs with `isEvalSupported: false` and its worker is loaded from the extension origin.
- `chrome.permissions.request` is called only from a click handler (the popup's, or the reader page's **Allow access** button) — the service worker has no user gesture to spend.
- Copy strings are verbatim from the spec: `What are you looking for? (optional)`, `Read this page`, `Read this PDF`, `Open the PDF reader`, `Highlights what carries the substance, dims the rest.`, `not a web page`, `reading N passages`, `stopped`, `this page does not look like an article (N passages)`, `reading`, `can't read this tab: <message>`, `can't fetch this file from <origin>`, `Allow access to <origin>`, `permission declined`, `no text found in this PDF (scanned pages need OCR, which jev-duo does not do)`, `Open a PDF from your computer`, `jev-duo reader`, `Show all`, `Dim again`, `Close`, `N of M judged`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/core/reading.ts` | Passage/DocContext types, constants, the question template, `decideReading` | 1 |
| `src/core/reading-judge.ts` | One Jev call per passage: concurrency, timeout, LRU cache, fail-open | 1 |
| `src/core/cache.ts` | +`sha256Hex` (the judge's cache key) | 1 |
| `src/core/evaluator.ts` | +`export` on `semaphore` | 1 |
| `src/extension/dom-text.ts` | `visibleText`/`collapsedText`, shared by the feed adapter and the article extractor | 2 |
| `src/extension/adapters/generic.ts` | imports the two helpers instead of owning them | 2 |
| `src/extension/reading/article.ts` | HTML → `Article` (candidates, container, context) | 2 |
| `src/extension/reading/pdf-text.ts` | `PageText[]` → `PdfDoc` (lines, bands, blocks); pure | 3 |
| `src/extension/reading/pdf-load.ts` | pdf.js → `PageText[]` (injected pdf.js module) | 3 |
| `tests/e2e/fixtures/make-sample-pdf.mjs` | deterministic generator for `sample.pdf` | 3 |
| `src/extension/messages.ts` | `Settings.focus`, the `readPassages` request/response | 4 |
| `src/extension/background.ts` | the `readPassages` handler and the judge's lifetime | 4 |
| `src/extension/reading/reader-ui.ts` | `READER_CSS`, the shadow-root panel, `ReaderHandle` | 4 |
| `src/extension/reading/run.ts` | the shared judging loop (batching, applying, summary) | 4 |
| `src/extension/read-page.ts` | the injected IIFE and its completion value | 4 |
| `src/extension/popup/*` | the **Read this page** section | 4 |
| `src/extension/reader/{reader.html,reader.ts,reader.css}` | the PDF reader page | 5 |
| `scripts/build.mjs` | the two new entries, the footer, the worker copy | 4, 5 |

---

### Task 1: Reading core — passages, questions, decision, judge

**Files:**
- Create: `src/core/reading.ts`, `src/core/reading-judge.ts`, `tests/unit/core/reading.test.ts`, `tests/unit/core/reading-judge.test.ts`, `tests/e2e/reading-live.spec.ts`
- Modify: `src/core/cache.ts` (add `sha256Hex`, have `verdictKey` use it), `src/core/evaluator.ts:22` (`export` the `semaphore` function)
- Test: the two new unit files plus the new `@live-jev` spec

**Interfaces:**
- Consumes: `fnv1a(str: string): number` (`src/core/hash.ts`); `LruCache<V>` with `get(k): V | undefined`, `set(k, v): void` (`src/core/cache.ts`); `JevQuestion`, `JevAnswer`, `JevRequest`, `JevResponse`, `JevProvider.evaluate(req, signal?): Promise<JevResponse>` (`src/core/providers/types.ts`); `createTypesafeJev({ apiKey, fetchImpl? }): JevProvider` (`src/core/providers/jev/typesafe.ts`).
- Produces, from `src/core/reading.ts`: `interface Passage { id: string; index: number; text: string; page?: number }`; `interface DocContext { title: string; lead: string; source: string }`; `const MIN_PASSAGE_CHARS = 40`, `MAX_PASSAGES = 600`, `JUDGE_TEXT_MAX = 1500`, `TITLE_MAX = 200`, `LEAD_MAX = 600`, `CORE_STATEMENT: string`, `KIND_OPTIONS: string[]`, `T_HIGHLIGHT_CORE = 0.7`, `T_HIGHLIGHT_FOCUS = 0.6`, `T_DIM = 0.3`; `passageId(text: string): string`; `readingQuestions(focus: string): JevQuestion[]`; `readingState(ctx: DocContext, passage: Passage): Record<string, unknown>`; `type ReadingVerdictKind = 'highlight' | 'dim' | 'plain'`; `interface ReadingVerdict { id: string; verdict: ReadingVerdictKind; p: number; core: number; focus?: number; kind?: string; error?: true }`; `decideReading(id: string, answers: JevAnswer[], hasFocus: boolean): ReadingVerdict`.
- Produces, from `src/core/reading-judge.ts`: `interface ReadingRun { verdicts: ReadingVerdict[]; usageTokens: number; errors: number; ms: number }`; `class ReadingJudge { constructor(jev: JevProvider, opts?: { concurrency?: number; timeoutMs?: number; cacheSize?: number }); judge(ctx: DocContext, focus: string, passages: Passage[], onVerdict?: (v: ReadingVerdict) => void): Promise<ReadingRun> }`.
- Produces, from `src/core/cache.ts`: `sha256Hex(input: string): Promise<string>`. From `src/core/evaluator.ts`: `semaphore(max: number): () => Promise<() => void>`.

- [ ] **Step 1: Write the failing unit tests for `reading.ts`**

Create `tests/unit/core/reading.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../../../src/core/providers/types';
import {
  CORE_STATEMENT,
  JUDGE_TEXT_MAX,
  KIND_OPTIONS,
  decideReading,
  passageId,
  readingQuestions,
  readingState,
  type DocContext,
  type Passage,
} from '../../../src/core/reading';

const CTX: DocContext = { title: 'Attention Layers', lead: 'We study attention.', source: 'https://example.test/paper' };
const passage = (text: string): Passage => ({ id: passageId(text), index: 0, text });

const noul = (id: string, p: number): JevAnswer => ({ id, type: 'noul', p });
const choice = (id: string, c: string): JevAnswer => ({ id, type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });

describe('readingQuestions', () => {
  it('without a focus asks core then kind, in that order', () => {
    const qs = readingQuestions('');
    expect(qs.map((q) => q.id)).toEqual(['core', 'kind']);
    expect(qs[0]).toEqual({ id: 'core', type: 'noul', statement: CORE_STATEMENT });
    expect(qs[1]).toEqual({ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS });
    expect(KIND_OPTIONS).toEqual(['claim', 'method', 'result', 'background', 'boilerplate']);
  });

  it('with a focus inserts the focus question between core and kind, with the text inlined', () => {
    const qs = readingQuestions('  how is positional information represented  ');
    expect(qs.map((q) => q.id)).toEqual(['core', 'focus', 'kind']);
    expect(qs[1]).toEqual({
      id: 'focus',
      type: 'noul',
      statement: 'The passage contains information that directly addresses the reader\'s question: "how is positional information represented".',
    });
  });

  it('treats whitespace as no focus at all', () => {
    expect(readingQuestions('   ').map((q) => q.id)).toEqual(['core', 'kind']);
  });
});

describe('readingState', () => {
  it('carries the title, the lead and the passage text', () => {
    expect(readingState(CTX, passage('A claim about attention.'))).toEqual({
      document_title: 'Attention Layers',
      document_lead: 'We study attention.',
      passage: 'A claim about attention.',
    });
  });

  it('truncates the passage at JUDGE_TEXT_MAX', () => {
    const long = 'x'.repeat(JUDGE_TEXT_MAX + 500);
    const state = readingState(CTX, passage(long));
    expect(JUDGE_TEXT_MAX).toBe(1500);
    expect(String(state.passage)).toHaveLength(JUDGE_TEXT_MAX);
  });
});

describe('passageId', () => {
  it('is stable, prefixed and derived from the first 300 chars only', () => {
    const head = 'y'.repeat(300);
    expect(passageId('hello')).toBe(passageId('hello'));
    expect(passageId('hello')).toMatch(/^rd:\d+$/);
    expect(passageId(`${head}a`)).toBe(passageId(`${head}b`));
  });
});

describe('decideReading', () => {
  // The table from spec §12, with the one row that §4.2 overrides — see the plan's Decisions (1).
  it.each([
    ['core .9, no focus', [noul('core', 0.9)], false, 'highlight', 0.9],
    ['core .7', [noul('core', 0.7)], false, 'highlight', 0.7],
    ['core .69', [noul('core', 0.69)], false, 'plain', 0.69],
    ['core .3', [noul('core', 0.3)], false, 'dim', 0.3],
    ['core .31', [noul('core', 0.31)], false, 'plain', 0.31],
    ['focus .6, core .2', [noul('core', 0.2), noul('focus', 0.6)], true, 'highlight', 0.6],
    ['focus .59, core .2', [noul('core', 0.2), noul('focus', 0.59)], true, 'plain', 0.59],
    ['focus .2, core .2', [noul('core', 0.2), noul('focus', 0.2)], true, 'dim', 0.2],
    ['focus .59, core .5', [noul('core', 0.5), noul('focus', 0.59)], true, 'plain', 0.59],
  ])('%s -> %s', (_label, answers, hasFocus, verdict, p) => {
    const v = decideReading('rd:1', answers as JevAnswer[], hasFocus as boolean);
    expect(v.verdict).toBe(verdict);
    expect(v.p).toBeCloseTo(p as number, 10);
  });

  it('treats a missing core answer as 0.5 and stays plain', () => {
    expect(decideReading('rd:1', [], false)).toEqual({ id: 'rd:1', verdict: 'plain', p: 0.5, core: 0.5 });
  });

  it('copies the kind choice and the focus probability onto the verdict', () => {
    const v = decideReading('rd:2', [noul('core', 0.8), noul('focus', 0.9), choice('kind', 'method')], true);
    expect(v).toEqual({ id: 'rd:2', verdict: 'highlight', p: 0.9, core: 0.8, focus: 0.9, kind: 'method' });
  });

  it('ignores a focus answer when no focus was set', () => {
    const v = decideReading('rd:3', [noul('core', 0.9), noul('focus', 0.1)], false);
    expect(v.p).toBe(0.9);
    expect(v.verdict).toBe('highlight');
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/core/reading.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/core/reading"`.

- [ ] **Step 3: Write `src/core/reading.ts`**

```ts
// Reading mode's fast-brain contract (design addendum 2026-09-22 §3/§4): what a passage is, what Jev
// is asked about one, and how the answers become highlight/dim/plain. Pure and DOM-free — the HTML
// extractor (src/extension/reading/article.ts), the PDF extractor (pdf-text.ts) and the reader UI all
// speak these types, and nothing here knows which of the two produced a passage.
//
// This is deliberately NOT a QuestionPack: there is no compiler, no strictness slider and no arbiter
// in reading mode (spec §13). The three questions are a fixed template with the user's focus inlined,
// which is what makes a TypeSafe-only setup (no LLM key at all) work.

import { fnv1a } from './hash';
import type { JevAnswer, JevQuestion } from './providers/types';

export interface Passage {
  id: string;
  index: number;
  /** Document order position, assigned by whoever extracted the passage. */
  text: string;
  /** 1-based page number; PDFs have one, HTML pages do not. */
  page?: number;
}

export interface DocContext {
  title: string;
  lead: string;
  /** The page URL, the PDF URL, or the picked file's name. */
  source: string;
}

export const MIN_PASSAGE_CHARS = 40;
export const MAX_PASSAGES = 600;
export const JUDGE_TEXT_MAX = 1500;
export const TITLE_MAX = 200;
export const LEAD_MAX = 600;

/** `rd:<fnv1a(first 300 chars)>` (§3). Stable across reloads and identical for two passages with the
 * same opening, which is what lets a mock fixture — and the judge's cache — be keyed by text alone. */
export function passageId(text: string): string {
  return `rd:${fnv1a(text.slice(0, 300))}`;
}

export const CORE_STATEMENT =
  "The passage states a substantive claim, method, finding, or explanation that carries the document's own content, rather than background, related work, acknowledgments, boilerplate, references, navigation, or filler.";

export const KIND_OPTIONS = ['claim', 'method', 'result', 'background', 'boilerplate'];

/** The per-passage question list (§4.1), in order: core, then focus only when one is set, then kind. */
export function readingQuestions(focus: string): JevQuestion[] {
  const trimmed = focus.trim();
  const questions: JevQuestion[] = [{ id: 'core', type: 'noul', statement: CORE_STATEMENT }];
  if (trimmed !== '') {
    questions.push({
      id: 'focus',
      type: 'noul',
      statement: `The passage contains information that directly addresses the reader's question: "${trimmed}".`,
    });
  }
  questions.push({ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS });
  return questions;
}

/** Everything Jev is told about one passage (§4.1) — the passage plus just enough of the document to
 * make "does this carry the document's own content?" answerable. Nothing else is ever sent (§11). */
export function readingState(ctx: DocContext, passage: Passage): Record<string, unknown> {
  return { document_title: ctx.title, document_lead: ctx.lead, passage: passage.text.slice(0, JUDGE_TEXT_MAX) };
}

export type ReadingVerdictKind = 'highlight' | 'dim' | 'plain';

export interface ReadingVerdict {
  id: string;
  verdict: ReadingVerdictKind;
  /** The probability the decision was made on: focus when a focus is set, else core. */
  p: number;
  core: number;
  focus?: number;
  kind?: string;
  error?: true;
}

export const T_HIGHLIGHT_CORE = 0.7;
export const T_HIGHLIGHT_FOCUS = 0.6;
export const T_DIM = 0.3;

/** §4.2. Fixed thresholds: the strictness slider is a feed-mode control and deliberately does not
 * apply here (§13). A passage with no `core` answer is treated as 0.5 — squarely plain — so a
 * malformed reply shows the passage as the page rendered it rather than dimming it. */
export function decideReading(id: string, answers: JevAnswer[], hasFocus: boolean): ReadingVerdict {
  let core = 0.5;
  let focus: number | undefined;
  let kind: string | undefined;
  for (const a of answers) {
    if (a.type === 'noul' && a.id === 'core') core = a.p;
    else if (a.type === 'noul' && a.id === 'focus') focus = a.p;
    else if (a.type === 'choice' && a.id === 'kind') kind = a.choice;
  }

  // With a focus set but no focus answer (a provider that dropped a question), `core` stands in for it
  // rather than the passage silently defaulting to 0.
  const decisive = hasFocus ? focus ?? core : core;
  const highlight = hasFocus ? decisive >= T_HIGHLIGHT_FOCUS : core >= T_HIGHLIGHT_CORE;
  // The focus guard is why a half-relevant passage is never dimmed: you asked about it.
  const dim = core <= T_DIM && (!hasFocus || decisive <= T_DIM);

  const out: ReadingVerdict = { id, verdict: highlight ? 'highlight' : dim ? 'dim' : 'plain', p: decisive, core };
  if (focus !== undefined) out.focus = focus;
  if (kind !== undefined) out.kind = kind;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/unit/core/reading.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Write the failing unit tests for `reading-judge.ts`**

Create `tests/unit/core/reading-judge.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JevProvider, JevRequest, JevResponse } from '../../../src/core/providers/types';
import { createMockJev } from '../../../src/core/providers/jev/mock';
import { passageId, type DocContext, type Passage, type ReadingVerdict } from '../../../src/core/reading';
import { ReadingJudge } from '../../../src/core/reading-judge';

const CTX: DocContext = { title: 'Sample Paper', lead: 'A lead paragraph.', source: 'https://example.test/p' };

function passages(...texts: string[]): Passage[] {
  return texts.map((text, index) => ({ id: passageId(text), index, text }));
}

/** A provider whose every answer is fixed, that records each request and reports the high-water mark
 * of concurrent calls. `gate` (when given) holds every call open until it is resolved. */
function stubJev(opts: { p?: number; usage?: number; gate?: Promise<void> } = {}): JevProvider & {
  requests: JevRequest[];
  maxInFlight: number;
} {
  let inFlight = 0;
  const stub = {
    name: 'stub',
    requests: [] as JevRequest[],
    maxInFlight: 0,
    async evaluate(req: JevRequest): Promise<JevResponse> {
      stub.requests.push(req);
      inFlight += 1;
      stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
      try {
        await (opts.gate ?? Promise.resolve());
        return {
          answers: req.questions.map((q) => (q.type === 'noul' ? { id: q.id, type: 'noul' as const, p: opts.p ?? 0.9 } : { id: q.id, type: 'choice' as const, choice: 'claim', probabilities: { claim: 1 }, confidence: 1 })),
          latencyMs: 1,
          usage: { inputTokens: opts.usage ?? 100 },
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return stub;
}

describe('ReadingJudge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns verdicts in passage order and fires onVerdict once per passage', async () => {
    const jev = stubJev();
    const seen: ReadingVerdict[] = [];
    const items = passages('first passage text', 'second passage text', 'third passage text');
    const run = await new ReadingJudge(jev).judge(CTX, '', items, (v) => seen.push(v));

    expect(run.verdicts.map((v) => v.id)).toEqual(items.map((p) => p.id));
    expect(run.verdicts.every((v) => v.verdict === 'highlight')).toBe(true);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((v) => v.id))).toEqual(new Set(items.map((p) => p.id)));
    expect(run.errors).toBe(0);
    expect(run.usageTokens).toBe(300);
    expect(run.ms).toBeGreaterThanOrEqual(0);
  });

  it('sends one request per passage, with the passage id as meta.itemId', async () => {
    const jev = stubJev();
    const items = passages('alpha passage', 'beta passage');
    await new ReadingJudge(jev).judge(CTX, 'what is beta', items);

    expect(jev.requests).toHaveLength(2);
    expect(jev.requests.map((r) => r.meta?.itemId).sort()).toEqual(items.map((p) => p.id).sort());
    expect(jev.requests[0].questions.map((q) => q.id)).toEqual(['core', 'focus', 'kind']);
    expect(jev.requests[0].state).toEqual({ document_title: 'Sample Paper', document_lead: 'A lead paragraph.', passage: expect.any(String) });
  });

  it('serves a repeat run from the cache: no second call and no tokens', async () => {
    const jev = stubJev();
    const judge = new ReadingJudge(jev);
    const items = passages('cached passage text goes here');

    const first = await judge.judge(CTX, '', items);
    const second = await judge.judge(CTX, '', items);

    expect(jev.requests).toHaveLength(1);
    expect(second.verdicts).toEqual(first.verdicts);
    expect(second.usageTokens).toBe(0);
  });

  it('keys the cache on the focus too, so changing the question re-asks', async () => {
    const jev = stubJev();
    const judge = new ReadingJudge(jev);
    const items = passages('cached passage text goes here');

    await judge.judge(CTX, '', items);
    await judge.judge(CTX, 'a different question', items);

    expect(jev.requests).toHaveLength(2);
  });

  it('keeps at most 6 calls in flight', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const jev = stubJev({ gate });
    const items = passages(...Array.from({ length: 20 }, (_, i) => `passage number ${i} with enough text`));

    const running = new ReadingJudge(jev).judge(CTX, '', items);
    await Promise.resolve();
    await Promise.resolve();
    open();
    await running;

    expect(jev.maxInFlight).toBeLessThanOrEqual(6);
    expect(jev.requests).toHaveLength(20);
  });

  it('turns a timeout into a plain verdict with error:true, counted in errors', async () => {
    vi.useFakeTimers();
    const hung: JevProvider = { name: 'hung', evaluate: () => new Promise<JevResponse>(() => {}) };
    const items = passages('a passage that never gets an answer');

    const running = new ReadingJudge(hung, { timeoutMs: 10_000 }).judge(CTX, '', items);
    await vi.advanceTimersByTimeAsync(10_000);
    const run = await running;

    expect(run.errors).toBe(1);
    expect(run.verdicts[0]).toEqual({ id: items[0].id, verdict: 'plain', p: 0.5, core: 0.5, error: true });
  });

  it('turns a throwing provider into the same fail-open verdict, and never caches it', async () => {
    let calls = 0;
    const flaky: JevProvider = {
      name: 'flaky',
      async evaluate(): Promise<JevResponse> {
        calls += 1;
        throw new Error('boom');
      },
    };
    const judge = new ReadingJudge(flaky);
    const items = passages('a passage whose provider explodes every time');

    expect((await judge.judge(CTX, '', items)).verdicts[0].error).toBe(true);
    await judge.judge(CTX, '', items);
    expect(calls).toBe(2); // a failure is never remembered as a verdict
  });

  it('works against the mock provider, honouring fixtures keyed by passage id', async () => {
    const items = passages('a passage the fixture pins to a high core probability');
    const jev = createMockJev({ fixtures: { [items[0].id]: { core: 0.95 } } });

    const run = await new ReadingJudge(jev).judge(CTX, '', items);

    expect(run.verdicts[0].verdict).toBe('highlight');
    expect(run.verdicts[0].core).toBe(0.95);
    expect(run.usageTokens).toBe(0); // the mock reports no usage
  });
});
```

- [ ] **Step 6: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/core/reading-judge.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/core/reading-judge"`.

- [ ] **Step 7: Export `sha256Hex` from `src/core/cache.ts` and `semaphore` from `src/core/evaluator.ts`**

In `src/core/cache.ts`, replace the `verdictKey` function (lines 44-51) with:

```ts
/** sha256(`input`) as lowercase hex, via the Web Crypto API (`globalThis.crypto.subtle`, not
 * `node:crypto`) so this runs unchanged in Node 20+, in a browser extension service worker and in a
 * content script. Shared by the feed evaluator's verdict key and the reading judge's passage key. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

/** sha256(pack.compiledAt + '|' + item.id + '|' + item.text). */
export async function verdictKey(pack: QuestionPack, item: Item): Promise<string> {
  return sha256Hex(`${pack.compiledAt}|${item.id}|${item.text}`);
}
```

In `src/core/evaluator.ts:22`, change `function semaphore(` to `export function semaphore(` (the doc comment above it stays as it is).

- [ ] **Step 8: Write `src/core/reading-judge.ts`**

```ts
// Reading mode's fast brain (design addendum §4.3): one Jev call per passage, six in flight, a 10 s
// per-call timeout, no retries, an LRU cache keyed by title|focus|text, and fail-open on anything
// that goes wrong. Deliberately not the Evaluator: there is no pack, no strictness, no arbiter and no
// DuoStats here, and the cache key is text-shaped rather than pack-shaped.
//
// The provider identity is NOT part of the cache key, exactly as in background.ts's verdict cache —
// which is why the background throws the whole judge away when the provider or a key changes (§9)
// rather than trying to invalidate entries.

import { LruCache, sha256Hex } from './cache';
import { semaphore } from './evaluator';
import type { JevProvider, JevQuestion, JevRequest, JevResponse } from './providers/types';
import { decideReading, readingQuestions, readingState, type DocContext, type Passage, type ReadingVerdict } from './reading';

export const READING_CONCURRENCY = 6;
export const READING_TIMEOUT_MS = 10_000;
export const READING_CACHE_SIZE = 2000;

export interface ReadingJudgeOptions {
  concurrency?: number;
  timeoutMs?: number;
  cacheSize?: number;
}

export interface ReadingRun {
  verdicts: ReadingVerdict[];
  usageTokens: number;
  errors: number;
  ms: number;
}

export class ReadingJudge {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly cache: LruCache<ReadingVerdict>;

  constructor(
    private readonly jev: JevProvider,
    opts: ReadingJudgeOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? READING_CONCURRENCY;
    this.timeoutMs = opts.timeoutMs ?? READING_TIMEOUT_MS;
    this.cache = new LruCache<ReadingVerdict>(opts.cacheSize ?? READING_CACHE_SIZE);
  }

  /** Judges every passage. Never rejects: one passage's failure is its own plain verdict and nothing
   * else's problem. `verdicts` comes back in passage order however the calls finished; `onVerdict`
   * fires as each one resolves, which is what lets the panel fill in while the rest is still running. */
  async judge(ctx: DocContext, focus: string, passages: Passage[], onVerdict?: (v: ReadingVerdict) => void): Promise<ReadingRun> {
    const started = Date.now();
    const hasFocus = focus.trim() !== '';
    const questions = readingQuestions(focus);
    const verdicts: ReadingVerdict[] = new Array<ReadingVerdict>(passages.length);
    const acquire = semaphore(this.concurrency);
    let usageTokens = 0;
    let errors = 0;

    await Promise.all(
      passages.map(async (passage, i) => {
        const key = await this.keyFor(ctx, focus, passage);
        const cached = key === undefined ? undefined : this.cache.get(key);
        if (cached) {
          // A hit costs no call and no tokens. The id is re-stamped because two passages with the
          // same first 300 characters share an id anyway, but a cached entry may have been stored
          // from a different position in a different document.
          const hit: ReadingVerdict = { ...cached, id: passage.id };
          verdicts[i] = hit;
          onVerdict?.(hit);
          return;
        }

        const release = await acquire();
        try {
          const res = await this.callOne(ctx, questions, passage);
          const verdict = decideReading(passage.id, res.answers, hasFocus);
          usageTokens += res.usage?.inputTokens ?? 0;
          if (key !== undefined) this.cache.set(key, verdict);
          verdicts[i] = verdict;
          onVerdict?.(verdict);
        } catch {
          // Fail open (§2): the passage is shown exactly as the document rendered it. Never cached —
          // a transient failure must not pin a passage to "plain" for the rest of the session.
          errors += 1;
          const failed: ReadingVerdict = { id: passage.id, verdict: 'plain', p: 0.5, core: 0.5, error: true };
          verdicts[i] = failed;
          onVerdict?.(failed);
        } finally {
          release();
        }
      }),
    );

    return { verdicts, usageTokens, errors, ms: Date.now() - started };
  }

  /** Best-effort cache key: no Web Crypto (an insecure context) degrades to "always a miss" rather
   * than failing the read — the same rule the evaluator's cache follows. */
  private async keyFor(ctx: DocContext, focus: string, passage: Passage): Promise<string | undefined> {
    try {
      return await sha256Hex(`${ctx.title}|${focus}|${passage.text}`);
    } catch {
      return undefined;
    }
  }

  private async callOne(ctx: DocContext, questions: JevQuestion[], passage: Passage): Promise<JevResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const req: JevRequest = { state: readingState(ctx, passage), questions, meta: { itemId: passage.id } };
      const call = this.jev.evaluate(req, controller.signal);
      call.catch(() => {}); // swallow a late rejection from the losing side of the race below
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });
      return await Promise.race([call, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 9: Run both unit files to verify they pass**

Run: `pnpm vitest run tests/unit/core/reading.test.ts tests/unit/core/reading-judge.test.ts tests/unit/core/cache.test.ts tests/unit/core/evaluator.test.ts`
Expected: PASS — the two new files plus the two refactored modules' existing suites.

- [ ] **Step 10: Write the `@live-jev` spec**

Create `tests/e2e/reading-live.spec.ts`. It drives `src/core` directly (no browser), the way `cli.spec.ts` drives the built CLI; `playwright.config.ts` has already loaded `.env`.

```ts
// The real TypeSafe API against three passages of the sample paper (design addendum §12): does the
// fast brain actually separate a method paragraph from the acknowledgments, and does a focus move the
// right paragraph up? Skipped unless LIVE=1 AND a key is present — playwright.config.ts loads .env on
// every run, so the key alone must not be enough to start spending money.
//
// The three texts are literals rather than an extraction of tests/e2e/fixtures/sample.pdf: this spec
// tests the core, and must not need the PDF pipeline to exist.

import { expect, test } from '@playwright/test';
import { createTypesafeJev } from '../../src/core/providers/jev/typesafe';
import { KIND_OPTIONS, passageId, type DocContext, type Passage } from '../../src/core/reading';
import { ReadingJudge, type ReadingRun } from '../../src/core/reading-judge';

const LIVE = process.env.LIVE === '1';
const JEV_KEY = process.env.TYPESAFE_API_KEY;

const METHOD =
  'The method encodes each input token as a vector, adds a positional signal to it, and then applies a stack of attention layers in which every position attends to every other position of the same sequence.';
const POSITIONAL =
  'Positional information is represented by fixed sinusoidal functions of the position index, one frequency per embedding dimension, so that a relative offset between two positions is a linear function of them.';
const ACK =
  'We thank our colleagues for their comments on an earlier draft, the reviewers for their careful reading, and the maintainers of the open source libraries this work depends on.';

const CTX: DocContext = {
  title: 'Sample Paper',
  lead: 'We describe a small sample document used to exercise the text layout extraction path of a reading assistant.',
  source: 'tests/e2e/fixtures/sample.pdf',
};

const PASSAGES: Passage[] = [METHOD, POSITIONAL, ACK].map((text, index) => ({ id: passageId(text), index, text }));

function verdictFor(run: ReadingRun, text: string) {
  const found = run.verdicts.find((v) => v.id === passageId(text));
  if (!found) throw new Error(`jev-duo live: no verdict for ${JSON.stringify(text.slice(0, 40))}`);
  return found;
}

test('reading mode: the real Jev API ranks substance over acknowledgments', { tag: '@live-jev' }, async () => {
  test.skip(!LIVE, 'set LIVE=1 to run tests that need the public internet');
  test.skip(!JEV_KEY, 'set TYPESAFE_API_KEY (repo .env is loaded by playwright.config.ts) to run the live reading test');
  test.setTimeout(120_000);

  const judge = new ReadingJudge(createTypesafeJev({ apiKey: JEV_KEY ?? '' }));

  const plain = await judge.judge(CTX, '', PASSAGES);
  expect(plain.errors).toBe(0);
  expect(verdictFor(plain, METHOD).core).toBeGreaterThan(verdictFor(plain, ACK).core);
  for (const v of plain.verdicts) expect(KIND_OPTIONS).toContain(v.kind);

  // A different focus is a different cache key, so this really is a second round of calls.
  const focused = await judge.judge(CTX, 'how is positional information represented', PASSAGES);
  expect(focused.errors).toBe(0);
  const positional = verdictFor(focused, POSITIONAL);
  const acknowledged = verdictFor(focused, ACK);
  expect(positional.focus).toBeDefined();
  expect(acknowledged.focus).toBeDefined();
  expect(positional.focus ?? 0).toBeGreaterThan(acknowledged.focus ?? 1);

  console.log(`live reading: ${plain.usageTokens + focused.usageTokens} input tokens, ${plain.ms + focused.ms} ms`);
});
```

- [ ] **Step 11: Verify the live spec skips cleanly and runs when asked**

Run: `pnpm test:e2e reading-live` — Expected: 1 skipped (no `LIVE=1`).
Run: `LIVE=1 pnpm test:e2e reading-live` — Expected: PASS when `.env` has `TYPESAFE_API_KEY`, skipped otherwise. Record the printed token count in the commit message body if it ran.

- [ ] **Step 12: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green; the e2e run reports one new skipped test.

- [ ] **Step 13: Commit**

```bash
git add src/core/reading.ts src/core/reading-judge.ts src/core/cache.ts src/core/evaluator.ts \
        tests/unit/core/reading.test.ts tests/unit/core/reading-judge.test.ts tests/e2e/reading-live.spec.ts
git commit -m "$(cat <<'EOF'
feat(core): reading mode passages, questions and the reading judge

The fast-brain half of reading mode: a fixed three-question template with
the reader's focus inlined, fixed highlight/dim thresholds, and a judge that
runs one call per passage six at a time behind an LRU cache and fails open.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: HTML articles — shared visible text and `extractArticle`

**Files:**
- Create: `src/extension/dom-text.ts`, `src/extension/reading/article.ts`, `tests/e2e/fixtures/article.html`, `tests/unit/extension/article.test.ts`
- Modify: `src/extension/adapters/generic.ts` (delete the four moved helpers and the walk counter; import them instead; `__generic` delegates)
- Test: the new `article.test.ts`, plus the unchanged `tests/unit/extension/generic-adapter.test.ts` as the regression gate on the move

**Interfaces:**
- Consumes: `MIN_PASSAGE_CHARS`, `MAX_PASSAGES`, `TITLE_MAX`, `LEAD_MAX`, `passageId(text)`, `DocContext`, `Passage` (Task 1, `src/core/reading.ts`).
- Produces, from `src/extension/dom-text.ts`: `isHidden(el: Element): boolean`; `visibleText(root: Element): string`; `collapsedText(el: Element): string`; `const __domText: { walks(): number; resetWalks(): void }`.
- Produces, from `src/extension/reading/article.ts`: `interface ArticlePassage extends Passage { el: Element }`; `interface Article { ctx: DocContext; passages: ArticlePassage[] }`; `extractArticle(doc: Document): Article | undefined`; `articleCandidates(doc: Document): Element[]`.
- Produces for the e2e: `tests/e2e/fixtures/article.html`, 21 qualifying passages, with `id` attributes `p-abstract`, `p-method-1`, `p-ack`, `p-boiler` on the four the Task 4 e2e pins probabilities to.

- [ ] **Step 1: Write the fixture `tests/e2e/fixtures/article.html`**

Every `<p>` sits on one line with no nested markup, so its collapsed text is exactly the literal between the tags — which is what lets the e2e compute `rd:<fnv1a(...)>` ids from these strings by hand.

```html
<!doctype html>
<!--
  An arXiv-like paper page for reading mode (design addendum §5/§12): 21 qualifying passages — the
  abstract plus four sections of five paragraphs — inside one <article>, with every shape that must
  NOT become a passage around them: a nav blurb, a figure caption, three hidden paragraphs, a
  bibliography of <li> (never <p>), and a footer. The paragraph texts are literal one-liners because
  tests/e2e/reading.spec.ts derives passage ids from them by hand.
-->
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Attention Layers for Long Documents</title>
  </head>
  <body>
    <nav>
      <a href="/">Home</a>
      <p>Browse by subject, by month, or by author; this navigation blurb is long enough to qualify on length alone and must still never be read.</p>
    </nav>

    <article>
      <h1>Attention Layers for Long Documents</h1>

      <p id="p-abstract">We study how attention layers behave on documents far longer than the window they were trained on, and show that a fixed sinusoidal encoding degrades more gracefully than a learned one.</p>

      <figure>
        <p>Figure 1 shows the attention mass assigned to each position as the document grows past the training window.</p>
        <figcaption>Figure 1: attention mass per position, averaged over four hundred documents.</figcaption>
      </figure>

      <p hidden>This paragraph is hidden with the hidden attribute and is long enough to qualify on length alone.</p>
      <p aria-hidden="true">This paragraph is hidden from assistive technology and is long enough to qualify on length alone.</p>
      <p style="display:none">This paragraph is display none and is long enough to qualify on length alone as well.</p>

      <section>
        <h2>1 Introduction</h2>
        <p id="p-intro-1">Long documents break the assumption that every position can be compared with every other one, because the cost of doing so grows with the square of the length.</p>
        <p id="p-intro-2">Most deployed readers therefore truncate, and a truncated document quietly loses whichever section happened to fall past the cutoff.</p>
        <p id="p-intro-3">We take the opposite approach and keep the whole document, paying for it with a cheaper comparison between positions that are far apart.</p>
        <p id="p-intro-4">The result is a model that answers questions about the last page of a report as accurately as it answers questions about the first one.</p>
        <p id="p-intro-5">Everything reported here was measured on public documents, and the extraction code used to produce the passages is released with the paper.</p>
      </section>

      <section>
        <h2>2 Method</h2>
        <p id="p-method-1">The method encodes each input token as a vector, adds a positional signal to it, and then applies a stack of attention layers in which every position attends to every other position of the same sequence.</p>
        <p id="p-method-2">Positional information is represented by fixed sinusoidal functions of the position index, one frequency per embedding dimension.</p>
        <p id="p-method-3">Each layer is followed by a residual connection and a normalisation step, which keeps the scale of the activations stable as the depth of the stack grows.</p>
        <p id="p-method-4">We train with a batch of sixty four documents and a learning rate that warms up over the first four thousand steps before decaying.</p>
        <p id="p-method-5">No part of the training data overlaps with the evaluation documents, which were collected after the training snapshot was frozen.</p>
      </section>

      <section>
        <h2>3 Results</h2>
        <p id="p-results-1">On documents of up to eight thousand tokens the model matches the truncating baseline, which is the range where the baseline still sees everything.</p>
        <p id="p-results-2">Past that length the baseline falls away quickly, while our model loses less than two points of accuracy out to sixty four thousand tokens.</p>
        <p id="p-results-3">The gap is largest on questions whose answer appears exactly once, late in the document, which is the case truncation handles worst.</p>
        <p id="p-results-4">Ablating the sinusoidal encoding in favour of a learned one costs four points at the longest length and nothing at all at the shortest.</p>
        <p id="p-results-5">We report the median of five runs; the spread between the best and the worst run never exceeded one point on any length.</p>
      </section>

      <section>
        <h2>4 Discussion and acknowledgments</h2>
        <p id="p-disc-1">The experiments here say nothing about generation, which has its own reasons to care about position and was out of scope for this work.</p>
        <p id="p-disc-2">We expect the same treatment to help retrieval systems that rank whole documents rather than fragments of them.</p>
        <p id="p-disc-3">The remaining failure cases are almost all tables, which our extraction step flattens into a single run of text before the model ever sees them.</p>
        <p id="p-ack">We thank our colleagues for their comments on an earlier draft, the reviewers for their careful reading, and the maintainers of the open source libraries this work depends on.</p>
        <p id="p-boiler">This work was supported by internal funding. The authors declare no competing interests. Correspondence should be addressed to the first author.</p>
      </section>

      <h2>References</h2>
      <ul class="bib">
        <li>Author A and Author B. Sparse attention for very long sequences. In Proceedings of a conference, pages 1 to 12, 2019.</li>
        <li>Author C. Learned position embeddings and what they forget. In Proceedings of another conference, pages 13 to 25, 2020.</li>
        <li>Author D and Author E. Truncation considered harmful for document question answering. Journal of Reading, 2020.</li>
        <li>Author F. On the cost of comparing every position with every other position. Journal of Long Inputs, 2021.</li>
        <li>Author G and Author H. A survey of long context evaluation sets and their many flaws. Surveys Quarterly, 2021.</li>
        <li>Author I. Residual connections at depth, revisited once more for good measure. Deep Things, 2021.</li>
        <li>Author J and Author K. Tables are not text, and pretending otherwise is expensive. Structured Data, 2022.</li>
        <li>Author L. Warmup schedules and the first four thousand steps of everything. Optimisation Notes, 2022.</li>
        <li>Author M and Author N. Retrieval over whole documents rather than fragments of them. Retrieval Today, 2023.</li>
        <li>Author O. Sinusoids, still: a defence of fixed positional encodings. Position Papers, 2023.</li>
        <li>Author P and Author Q. Measuring accuracy at sixty four thousand tokens without cheating. Benchmarks, 2024.</li>
        <li>Author R. Everything we tried that did not work, in chronological order. Negative Results, 2024.</li>
      </ul>
    </article>

    <footer>
      <p>Copyright 2026 the authors. This footer paragraph is long enough to qualify on length alone and must still be excluded from the passages.</p>
    </footer>
  </body>
</html>
```

- [ ] **Step 2: Write the failing tests `tests/unit/extension/article.test.ts`**

```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { passageId } from '../../../src/core/reading';
import { articleCandidates, extractArticle } from '../../../src/extension/reading/article';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string): Document {
  return new DOMParser().parseFromString(readFileSync(path.join(FIXTURES, name), 'utf8'), 'text/html');
}

function parse(body: string, head = ''): Document {
  return new DOMParser().parseFromString(`<html><head>${head}</head><body>${body}</body></html>`, 'text/html');
}

/** `n` paragraphs of `chars` characters each, each one distinct so no two share an id. */
function paragraphs(n: number, chars: number, prefix = 'para'): string {
  return Array.from({ length: n }, (_, i) => `<p>${prefix} ${i} ${'x'.repeat(Math.max(0, chars - `${prefix} ${i} `.length))}</p>`).join('');
}

describe('extractArticle on the arXiv-like fixture', () => {
  it('finds exactly the 21 body paragraphs, in document order', () => {
    const article = extractArticle(loadDoc('article.html'));
    expect(article).toBeDefined();
    expect(article?.passages).toHaveLength(21);
    expect(article?.passages.map((p) => p.index)).toEqual([...Array(21).keys()]);
    expect(article?.passages[0].el.id).toBe('p-abstract');
    expect(article?.passages.at(-1)?.el.id).toBe('p-boiler');
  });

  it('takes no passage from the bibliography, the nav, the figure, the footer or a hidden paragraph', () => {
    const passages = extractArticle(loadDoc('article.html'))?.passages ?? [];
    const texts = passages.map((p) => p.text).join('\n');
    expect(texts).not.toContain('Sparse attention for very long sequences');
    expect(texts).not.toContain('Browse by subject');
    expect(texts).not.toContain('Figure 1 shows the attention mass');
    expect(texts).not.toContain('Copyright 2026 the authors');
    expect(texts).not.toContain('hidden with the hidden attribute');
    expect(texts).not.toContain('hidden from assistive technology');
    expect(texts).not.toContain('display none');
  });

  it('derives ids from the passage text and stamps them on every passage', () => {
    const article = extractArticle(loadDoc('article.html'));
    const abstract = article?.passages[0];
    expect(abstract?.id).toBe(passageId(abstract?.text ?? ''));
    expect(abstract?.id).toMatch(/^rd:\d+$/);
    expect(new Set(article?.passages.map((p) => p.id)).size).toBe(21); // no two paragraphs collide
  });

  it('takes the title from the h1 and the lead from the first passage', () => {
    const doc = loadDoc('article.html');
    const article = extractArticle(doc);
    expect(article?.ctx.title).toBe('Attention Layers for Long Documents');
    expect(article?.ctx.lead).toBe(article?.passages[0].text);
    expect(article?.ctx.source).toBe(doc.URL);
  });
});

describe('extractArticle container descent', () => {
  it('keeps the common parent when comments hold a quarter of the text (a blog)', () => {
    const doc = parse(`
      <article>${paragraphs(8, 120, 'post')}</article>
      <section id="comments">${paragraphs(3, 120, 'comment')}</section>
    `);
    const article = extractArticle(doc);
    expect(article?.passages).toHaveLength(11);
    expect(article?.passages[8].text.startsWith('comment 0')).toBe(true);
  });

  it('descends into the one child that holds nearly all of the text', () => {
    const doc = parse(`
      <div id="shell">
        <div id="main">${paragraphs(10, 200, 'body')}</div>
        <div id="aside-ish"><p>${'z'.repeat(60)}</p></div>
      </div>
    `);
    const article = extractArticle(doc);
    expect(article?.passages).toHaveLength(10); // the 60-char sibling is outside #main and so outside the container
  });
});

describe('extractArticle rejections', () => {
  it('returns undefined for a docs page of four short paragraphs', () => {
    expect(extractArticle(parse(`
      <h1>Getting started</h1>
      <p>Install it with your package manager of choice today.</p>
      <p>Configuration lives in a single yaml file at the root.</p>
      <p>Run the binary with the config flag pointed at that file.</p>
      <p>Everything else is covered in the frequently asked questions.</p>
    `))).toBeUndefined();
  });

  it('returns undefined for an empty app shell', () => {
    expect(extractArticle(parse('<div id="root"></div>'))).toBeUndefined();
  });

  it('returns undefined when six paragraphs do not add up to 1500 characters', () => {
    expect(extractArticle(parse(paragraphs(6, 50)))).toBeUndefined();
  });

  it('accepts exactly six paragraphs once they clear 1500 characters', () => {
    expect(extractArticle(parse(paragraphs(6, 260)))?.passages).toHaveLength(6);
  });
});

describe('extractArticle context and caps', () => {
  it('prefers a meta description of 40 characters or more as the lead', () => {
    const description = 'A description long enough to be worth using as the document lead.';
    const doc = parse(paragraphs(8, 200), `<meta name="description" content="${description}" />`);
    expect(extractArticle(doc)?.ctx.lead).toBe(description);
  });

  it('falls back to the first passage when the meta description is too short', () => {
    const doc = parse(paragraphs(8, 200), '<meta name="description" content="Too short." />');
    const article = extractArticle(doc);
    expect(article?.ctx.lead).toBe(article?.passages[0].text);
  });

  it('falls back to document.title when the container has no h1, and truncates both caps', () => {
    const doc = parse(paragraphs(8, 900), `<title>${'T'.repeat(300)}</title>`);
    const article = extractArticle(doc);
    expect(article?.ctx.title).toHaveLength(200);
    expect(article?.ctx.lead).toHaveLength(600);
  });

  it('keeps the first 600 passages of a longer document', () => {
    const article = extractArticle(parse(paragraphs(700, 60)));
    expect(article?.passages).toHaveLength(600);
    expect(article?.passages.at(-1)?.text.startsWith('para 599')).toBe(true);
  });
});

describe('articleCandidates', () => {
  it('counts every qualifying paragraph, whatever the container decides', () => {
    expect(articleCandidates(loadDoc('article.html'))).toHaveLength(21);
    expect(articleCandidates(parse('<div id="root"></div>'))).toHaveLength(0);
    expect(articleCandidates(parse('<p>short</p><p>also short</p>'))).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/extension/article.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/reading/article"`.

- [ ] **Step 4: Create `src/extension/dom-text.ts` with the helpers moved out of `generic.ts`**

The bodies of `isHidden`, `visibleText` and `collapsedText` are copied verbatim from `adapters/generic.ts:32-74`; only their home changes.

```ts
// "What does a human actually see in this element?" — the one answer the feed adapter and the reading
// mode article extractor both need. It lived in adapters/generic.ts until reading mode asked the same
// question (design addendum §5.1 defines its candidate rule as "the generic adapter's visibleText
// rules"), and a second copy would drift from the first the moment either one learned a new way for a
// page to hide something. Pure DOM: no chrome.*, no layout (jsdom has none), structural only.

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// `\b` after none/hidden rejects "display:nonesuch"/"visibility:hiddenpopup" while still matching
// "display: none !important" (a boundary sits between "e" and " "/end-of-string either way).
const HIDDEN_STYLE = /display\s*:\s*none\b|visibility\s*:\s*hidden\b/i;

/** Counts `visibleText` calls since the last `__domText.resetWalks()`; read only by the generic
 * adapter's unit test, which pins down "each element's text is walked once per scan". */
let textWalks = 0;

export function isHidden(el: Element): boolean {
  return (
    SKIPPED_TAGS.has(el.tagName) ||
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true' ||
    HIDDEN_STYLE.test(el.getAttribute('style') ?? '')
  );
}

// `root`'s text minus script/style/noscript/template subtrees and minus any hidden/aria-hidden/
// inline-hidden element's subtree. Iterative (an explicit stack of {nodes, i} frames, not recursion)
// so an unusually deep chain of wrapper elements can't blow the call stack; each frame resumes exactly
// where it left off once the child it just pushed is fully drained, which visits nodes in the same
// document order recursion would.
export function visibleText(root: Element): string {
  textWalks += 1;
  if (isHidden(root)) return '';
  const parts: string[] = [];
  const stack: Array<{ nodes: NodeListOf<ChildNode>; i: number }> = [{ nodes: root.childNodes, i: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const child = frame.nodes[frame.i++];
    if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE && !isHidden(child as Element)) {
      stack.push({ nodes: (child as Element).childNodes, i: 0 });
    }
  }
  return parts.join('');
}

export function collapsedText(el: Element): string {
  return visibleText(el).replace(/\s+/g, ' ').trim();
}

/** Test hook only: the walk counter, and a way to zero it between tests. Never read by production
 * code — `__generic.textWalks()`/`__generic.reset()` forward to it so the adapter's existing hook
 * keeps working unchanged. */
export const __domText = {
  walks: (): number => textWalks,
  resetWalks(): void {
    textWalks = 0;
  },
};
```

- [ ] **Step 5: Point `src/extension/adapters/generic.ts` at the new module**

1. Delete `SKIPPED_TAGS`, `HIDDEN_STYLE`, `isHidden`, the `textWalks` counter, `visibleText` and `collapsedText` (lines 19-22 and 32-74 of the current file), together with their comments — they now live in `dom-text.ts`.
2. Add to the imports at the top: `import { __domText, collapsedText } from '../dom-text';`
3. Replace the `__generic` hook's two affected members so the existing test keeps reading the same numbers:

```ts
export const __generic = {
  now: (): number => Date.now(),
  textWalks: (): number => __domText.walks(),
  reset(): void {
    cache = undefined;
    callsSinceFullScan = 0;
    lastFullScanAt = 0;
    __domText.resetWalks();
  },
};
```

- [ ] **Step 6: Run the generic adapter's suite to prove the move changed nothing**

Run: `pnpm vitest run tests/unit/extension/generic-adapter.test.ts`
Expected: PASS, unchanged — including the `expect(__generic.textWalks()).toBe(6)` case.

- [ ] **Step 7: Write `src/extension/reading/article.ts`**

```ts
// Reading mode's HTML source (design addendum §5): every paragraph that carries the document's own
// text, in document order, plus the title and lead the judge is given as context. No per-site
// selectors and no chrome.* — this runs inside whatever page the user clicked Read on, and inside
// jsdom in the tests. The generic feed adapter's question is "which blocks repeat?"; this one's is
// "which paragraphs are the document?", which is why they share only visible-text extraction.

import { LEAD_MAX, MAX_PASSAGES, MIN_PASSAGE_CHARS, TITLE_MAX, passageId, type DocContext, type Passage } from '../../core/reading';
import { collapsedText } from '../dom-text';

export interface ArticlePassage extends Passage {
  el: Element;
}

export interface Article {
  ctx: DocContext;
  passages: ArticlePassage[];
}

const MIN_ARTICLE_PASSAGES = 6;
const MIN_ARTICLE_CHARS = 1500;
/** Descend into a child only while it holds this much of its parent's candidate text (§5.2). */
const CONTAINER_SHARE = 0.8;

/** Everything a passage may not sit inside (§5.1) — chrome, controls, captions and code, all of which
 * are real text a reader is not reading *as the document*. Asked once per candidate with `closest`. */
const EXCLUDED_ANCESTORS =
  'nav, header, footer, aside, form, figure, figcaption, table, pre, code, [role="navigation"], [role="complementary"], [contenteditable]';

/** Each qualifying paragraph with its collapsed text, memoised together so the text walk (the most
 * expensive thing this file does) happens once per paragraph rather than once per reader. */
function candidatesWithText(doc: Document): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  for (const p of doc.body.querySelectorAll('p')) {
    if (p.closest(EXCLUDED_ANCESTORS)) continue;
    const text = collapsedText(p);
    if (text.length >= MIN_PASSAGE_CHARS) out.push([p, text]);
  }
  return out;
}

/** Every paragraph that could be a passage, container or not. §8.1's `no-article` result reports this
 * count, which is the difference between "this page is not an article" and "this page has no text". */
export function articleCandidates(doc: Document): Element[] {
  return candidatesWithText(doc).map(([el]) => el);
}

/** §5.2: start at `body` and keep descending while one child holds 80 % of the candidate text below
 * the current node. A blog whose comments hold a quarter of the text keeps the common parent — by
 * design: the reader is explicit, and comments are readable too. */
function containerOf(doc: Document, candidates: Array<[Element, string]>): Element {
  const mass = (node: Element): number => candidates.reduce((sum, [el, text]) => (node.contains(el) ? sum + text.length : sum), 0);
  let node: Element = doc.body;
  for (;;) {
    const total = mass(node);
    if (total === 0) return node;
    let best: Element | undefined;
    let bestMass = 0;
    for (const child of node.children) {
      const m = mass(child);
      if (m > bestMass) {
        best = child;
        bestMass = m;
      }
    }
    if (!best || bestMass < total * CONTAINER_SHARE) return node;
    node = best;
  }
}

/** §5.5. `source` reads the host window's location so a detached document (a DOMParser document in a
 * test) resolves to its own URL instead of whatever page happens to be global. */
function contextOf(doc: Document, container: Element, lead: string): DocContext {
  const h1 = container.querySelector('h1');
  const heading = h1 ? collapsedText(h1) : '';
  const description = (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: (heading || doc.title).slice(0, TITLE_MAX),
    lead: (description.length >= MIN_PASSAGE_CHARS ? description : lead).slice(0, LEAD_MAX),
    source: doc.defaultView?.location.href ?? doc.URL,
  };
}

/** The whole of §5. `undefined` means "this does not look like an article", which the caller shows as
 * a message rather than an empty reader — never a partial read. */
export function extractArticle(doc: Document): Article | undefined {
  const candidates = candidatesWithText(doc);
  if (candidates.length === 0) return undefined;

  const container = containerOf(doc, candidates);
  const inside = candidates.filter(([el]) => container.contains(el)).slice(0, MAX_PASSAGES);
  if (inside.length < MIN_ARTICLE_PASSAGES) return undefined;
  if (inside.reduce((sum, [, text]) => sum + text.length, 0) < MIN_ARTICLE_CHARS) return undefined;

  const passages: ArticlePassage[] = inside.map(([el, text], index) => ({ id: passageId(text), index, text, el }));
  return { ctx: contextOf(doc, container, passages[0].text), passages };
}
```

- [ ] **Step 8: Run the article tests to verify they pass**

Run: `pnpm vitest run tests/unit/extension/article.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 9: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green. The new fixture is served by the e2e server but nothing opens it yet.

- [ ] **Step 10: Commit**

```bash
git add src/extension/dom-text.ts src/extension/adapters/generic.ts src/extension/reading/article.ts \
        tests/e2e/fixtures/article.html tests/unit/extension/article.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): extract article passages from an HTML page

Paragraph candidates by the generic adapter's visible-text rules, then a
mass-based descent to the container that holds them, then the title and lead
the judge is given. visibleText/collapsedText move to dom-text.ts so the feed
adapter and the reader share one answer to "what can a human see here?".

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: PDF text — geometry, loading, and a hand-built sample

**Files:**
- Create: `src/extension/reading/pdf-text.ts`, `src/extension/reading/pdf-load.ts`, `tests/e2e/fixtures/make-sample-pdf.mjs`, `tests/e2e/fixtures/sample.pdf` (generated, committed), `tests/unit/extension/pdf-text.test.ts`, `tests/unit/extension/pdf-load.test.ts`
- Modify: `package.json` (dependency `pdfjs-dist@^6.3.289`, script `fixtures:pdf`)
- Test: the two new unit files

**Interfaces:**
- Consumes: `MIN_PASSAGE_CHARS`, `MAX_PASSAGES` (Task 1, `src/core/reading.ts`).
- Produces, from `src/extension/reading/pdf-text.ts`: `interface TextItem { str: string; x: number; y: number; size: number; width: number; rotated: boolean }`; `interface PageText { page: number; width: number; height: number; items: TextItem[] }`; `type Block = { kind: 'heading'; text: string; page: number } | { kind: 'passage'; text: string; page: number }`; `interface PdfDoc { title: string; blocks: Block[] }`; `pagesToBlocks(pages: PageText[], fallbackTitle: string): PdfDoc`.
- Produces, from `src/extension/reading/pdf-load.ts`: `interface PdfPageLike { view: number[]; getTextContent(): Promise<{ items: unknown[] }> }`; `interface PdfDocumentLike { numPages: number; getPage(pageNumber: number): Promise<PdfPageLike>; getMetadata(): Promise<unknown>; destroy?(): Promise<void> }`; `interface PdfjsLike { getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> } }`; `loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }>`.
- Produces for Task 5 and the e2e: `tests/e2e/fixtures/sample.pdf` — 2 pages, Info `/Title (Sample Paper)`, 4 heading blocks and 8 passage blocks, the running header `Sample Paper - draft` on both pages.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add pdfjs-dist@^6.3.289`
Then add to `package.json`'s `scripts`, after `"build:icons"`: `"fixtures:pdf": "node tests/e2e/fixtures/make-sample-pdf.mjs",`
Expected: `pdfjs-dist` appears under `dependencies` (the reader page bundles it, so it is not a devDependency) and `pnpm-lock.yaml` updates. Leave `engines.node` at `>=20`: pdfjs-dist wants ≥ 22.13, but nothing in the published CLI bundle imports it, and CI already runs Node 22.

- [ ] **Step 2: Write the failing tests `tests/unit/extension/pdf-text.test.ts`**

Every rule of §6.1 is driven from synthetic `PageText`, which is the whole reason the module is pdf.js-free.

```ts
import { describe, expect, it } from 'vitest';
import { pagesToBlocks, type PageText, type TextItem } from '../../../src/extension/reading/pdf-text';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** One drawn string at (x, y): pdf.js emits one item per Tj, with a width it measured itself. */
function item(str: string, x: number, y: number, size = 10, opts: { width?: number; rotated?: boolean } = {}): TextItem {
  return { str, x, y, size, width: opts.width ?? str.length * size * 0.5, rotated: opts.rotated ?? false };
}

function page(n: number, items: TextItem[]): PageText {
  return { page: n, width: PAGE_WIDTH, height: PAGE_HEIGHT, items };
}

const texts = (pages: PageText[], kind: 'heading' | 'passage'): string[] =>
  pagesToBlocks(pages, 'fallback').blocks.filter((b) => b.kind === kind).map((b) => b.text);

/** 43 characters, so a single line of it already clears the 40-char passage floor. */
const SENTENCE = 'A sentence with more than forty characters.';

describe('pagesToBlocks lines and blocks', () => {
  it('joins items on the same baseline in x order, collapsing whitespace', () => {
    const blocks = texts([page(1, [item('world.  ', 200, 700), item('Hello  ', 72, 700), item(SENTENCE, 72, 686)])], 'passage');
    expect(blocks[0]).toBe(`Hello world. ${SENTENCE}`);
  });

  it('starts a new block when the vertical gap exceeds 1.45 line sizes', () => {
    const blocks = texts(
      [page(1, [item(`First. ${SENTENCE}`, 72, 700), item('Still the first block.', 72, 686), item(`Second. ${SENTENCE}`, 72, 662)])],
      'passage',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`First. ${SENTENCE} Still the first block.`);
    expect(blocks[1]).toBe(`Second. ${SENTENCE}`);
  });

  it('joins a hyphenated break and keeps a hyphen before a capital', () => {
    const joined = texts([page(1, [item(`${SENTENCE} trans-`, 72, 700), item('former layers follow.', 72, 686)])], 'passage');
    expect(joined[0]).toContain('transformer layers follow.');

    const kept = texts([page(1, [item(`${SENTENCE} re-`, 72, 700), item('Use is discouraged.', 72, 686)])], 'passage');
    expect(kept[0]).toContain('re- Use is discouraged.');
  });

  it('starts a new block when the size changes by more than a point', () => {
    const blocks = texts([page(1, [item(SENTENCE, 72, 700, 10), item(`${SENTENCE} but bigger`, 72, 686, 12)])], 'passage');
    expect(blocks).toHaveLength(2);
  });

  it('drops rotated items entirely', () => {
    const blocks = texts([page(1, [item(SENTENCE, 72, 700), item('WATERMARK DRAFT COPY DO NOT CIRCULATE', 300, 400, 30, { rotated: true })])], 'passage');
    expect(blocks.join(' ')).not.toContain('WATERMARK');
  });
});

describe('pagesToBlocks headings and kinds', () => {
  const body = [item(SENTENCE, 72, 650), item(`${SENTENCE} More body text.`, 72, 636)];

  it('calls a short line at 1.15x the body size a heading, and drops short non-heading lines', () => {
    const doc = pagesToBlocks([page(1, [item('1 Introduction', 72, 700, 14), ...body, item('ok', 72, 600)])], 'fallback');
    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['1 Introduction']);
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(1);
    expect(doc.blocks.map((b) => b.text)).not.toContain('ok');
  });

  it('takes the title from the largest page-1 block of at least eight characters', () => {
    const doc = pagesToBlocks(
      [
        page(1, [item('Sample Paper', 72, 740, 18), item('1 Introduction', 72, 700, 14), ...body]),
        page(2, [item('An Even Bigger Line On Page Two', 72, 740, 24)]),
      ],
      'fallback',
    );
    expect(doc.title).toBe('Sample Paper');
  });

  it('falls back to the given title when page one has no block long enough', () => {
    expect(pagesToBlocks([page(1, [item('Tiny', 72, 740, 18)])], 'my-file.pdf').title).toBe('my-file.pdf');
  });
});

describe('pagesToBlocks running headers and page numbers', () => {
  const bodyOf = (n: number): TextItem[] => [item(`${SENTENCE} Page ${n} body.`, 72, 650), item('A second line of that same body block.', 72, 636)];

  it('drops a header repeated at the same y on three pages, and the page numbers', () => {
    const pages = [1, 2, 3].map((n) => page(n, [item('Sample Paper - draft', 72, 770), ...bodyOf(n), item(String(n), 300, 40)]));
    const doc = pagesToBlocks(pages, 'fallback');
    const all = doc.blocks.map((b) => b.text).join('\n');
    expect(all).not.toContain('Sample Paper - draft');
    expect(doc.blocks.map((b) => b.text)).not.toContain('1');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(3);
  });

  it('normalises digits, so "Page 1 of 9" and "Page 2 of 9" count as the same running line', () => {
    const pages = [1, 2].map((n) => page(n, [item(`Page ${n} of 9`, 72, 770), ...bodyOf(n)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.map((b) => b.text).join('\n')).not.toContain('of 9');
  });

  it('keeps a line that appears on only one page of a two-page document', () => {
    // The floor of two pages: "half the pages" alone would be 1 here and would drop every line.
    const pages = [page(1, [item('Sample Paper', 72, 740, 18), ...bodyOf(1)]), page(2, bodyOf(2))];
    const doc = pagesToBlocks(pages, 'fallback');
    expect(doc.blocks.map((b) => b.text)).toContain('Sample Paper');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(2);
  });

  it('drops roman numerals as page numbers too', () => {
    const pages = [1, 2].map((n) => page(n, [...bodyOf(n), item(n === 1 ? 'iv' : 'v', 300, 40)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.map((b) => b.text).join('\n')).not.toContain('iv');
  });
});

describe('pagesToBlocks columns', () => {
  it('reads a two-column band left column first, between the full-width lines around it', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const doc = pagesToBlocks(
      [
        page(1, [
          full('A Two Column Paper', 740, 18),
          item(`LEFT. ${SENTENCE}`, 72, 700, 10, { width: 200 }),
          item('More of the left column here.', 72, 686, 10, { width: 200 }),
          item(`RIGHT. ${SENTENCE}`, 340, 700, 10, { width: 200 }),
          item('More of the right column here.', 340, 686, 10, { width: 200 }),
          full(`CAPTION. ${SENTENCE}`, 600),
        ]),
      ],
      'fallback',
    );
    const passages = doc.blocks.filter((b) => b.kind === 'passage').map((b) => b.text);
    expect(passages).toHaveLength(3);
    expect(passages[0].startsWith('LEFT.')).toBe(true);
    expect(passages[1].startsWith('RIGHT.')).toBe(true);
    expect(passages[2].startsWith('CAPTION.')).toBe(true);
    expect(doc.title).toBe('A Two Column Paper');
  });
});

describe('pagesToBlocks caps', () => {
  it('keeps the first 600 passages and counts no heading against the cap', () => {
    const items: TextItem[] = [item('A Heading Line', 72, 780, 18)];
    for (let i = 0; i < 700; i++) items.push(item(`Passage number ${i} with more than forty characters of text.`, 72, 760 - i * 40));
    const doc = pagesToBlocks([page(1, items)], 'fallback');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(600);
    expect(doc.blocks.filter((b) => b.kind === 'heading')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/extension/pdf-text.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/reading/pdf-text"`.

- [ ] **Step 4: Write `src/extension/reading/pdf-text.ts`**

```ts
// PDF text geometry (design addendum §6.1). pdf.js hands back a flat list of positioned strings with
// no notion of a line, a column or a paragraph; rebuilding those is this file's whole job, and it is
// deliberately pdf.js-free and pure so every rule can be driven from synthetic input in a unit test.
// Everything is per page, then joined in page order: a block never spans a page break.

import { MAX_PASSAGES, MIN_PASSAGE_CHARS } from '../../core/reading';

export interface TextItem {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  rotated: boolean;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  items: TextItem[];
}

export type Block = { kind: 'heading'; text: string; page: number } | { kind: 'passage'; text: string; page: number };

export interface PdfDoc {
  title: string;
  blocks: Block[];
}

const LINE_Y_TOLERANCE = 2;
const HEADER_Y_TOLERANCE = 3;
const RUNNING_MIN_PAGES = 3;
const FULL_WIDTH_SHARE = 0.6;
const GAP_FACTOR = 1.45;
const SIZE_STEP = 1;
const HEADING_FACTOR = 1.15;
const HEADING_MAX_CHARS = 120;
const TITLE_MIN_CHARS = 8;
const PAGE_NUMBER_MAX_CHARS = 4;
const ROMAN = /^[ivxlcdm]+$/i;

type Column = 'full' | 'left' | 'right';

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
  page: number;
  column: Column;
}

interface Draft {
  kind: 'heading' | 'passage';
  text: string;
  page: number;
  size: number;
}

/** §6.1.2. Items join the CURRENT line, in the order pdf.js emitted them: a global sort by y would
 * merge the left and right columns of a two-column page into one line, since they share baselines. */
function linesOf(page: PageText): Line[] {
  const groups: TextItem[][] = [];
  for (const item of page.items) {
    if (item.rotated || item.str.trim() === '') continue;
    const current = groups[groups.length - 1];
    if (current && Math.abs(item.y - current[0].y) <= LINE_Y_TOLERANCE) current.push(item);
    else groups.push([item]);
  }
  return groups.map((items) => toLine(items, page));
}

function toLine(items: TextItem[], page: PageText): Line {
  // pdf.js items carry their own spaces, so the join is '' — adding one would double every space.
  const text = [...items]
    .sort((a, b) => a.x - b.x)
    .map((it) => it.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  let biggest = items[0];
  for (const it of items) if (it.str.length > biggest.str.length) biggest = it;
  const x = Math.min(...items.map((it) => it.x));
  const right = Math.max(...items.map((it) => it.x + it.width));
  // §6.1.5: a line that spans most of the page is `full` and ends whatever column band it follows.
  const column: Column = right - x >= FULL_WIDTH_SHARE * page.width ? 'full' : x < page.width / 2 ? 'left' : 'right';
  return { text, x, right, y: items[0].y, size: biggest.size, page: page.page, column };
}

/** §6.1.3: the size, rounded to half a point, that carries the most characters in the document. Ties
 * go to the smaller size so the result never depends on page order. */
function bodySize(lines: Line[]): number {
  const chars = new Map<number, number>();
  for (const line of lines) {
    const bucket = Math.round(line.size * 2) / 2;
    chars.set(bucket, (chars.get(bucket) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [size, count] of chars) {
    if (count > bestChars || (count === bestChars && size < best)) {
      best = size;
      bestChars = count;
    }
  }
  return best || 1;
}

const normalize = (text: string): string => text.toLowerCase().replace(/\d/g, '#');

const isPageNumber = (text: string): boolean => text.length <= PAGE_NUMBER_MAX_CHARS && (/^\d+$/.test(text) || ROMAN.test(text));

/** §6.1.4. A running header is the same normalised text at the same height on enough pages; "enough"
 * has a floor of two, because one page can never show a repetition and "half of two" would otherwise
 * drop every line of a two-page document — including its title. */
function runningFilter(lines: Line[], pageCount: number): (line: Line) => boolean {
  const threshold = pageCount >= 6 ? RUNNING_MIN_PAGES : Math.max(2, Math.ceil(pageCount / 2));
  const byText = new Map<string, Line[]>();
  for (const line of lines) {
    const key = normalize(line.text);
    const list = byText.get(key);
    if (list) list.push(line);
    else byText.set(key, [line]);
  }

  const dropped = new Set<Line>();
  for (const group of byText.values()) {
    if (group.length < threshold) continue;
    for (const anchor of group) {
      const near = group.filter((l) => Math.abs(l.y - anchor.y) <= HEADER_Y_TOLERANCE);
      if (new Set(near.map((l) => l.page)).size < threshold) continue;
      for (const l of near) dropped.add(l);
    }
  }
  return (line) => dropped.has(line) || isPageNumber(line.text);
}

/** §6.1.5. Top to bottom, with each columnar band re-ordered so its left column is read before its
 * right one; a full-width line closes the band it follows. */
function readingOrder(lines: Line[]): Line[] {
  const out: Line[] = [];
  let band: Line[] = [];
  const flush = (): void => {
    if (band.length === 0) return;
    out.push(...band.filter((l) => l.column === 'left'), ...band.filter((l) => l.column === 'right'));
    band = [];
  };
  for (const line of [...lines].sort((a, b) => b.y - a.y)) {
    if (line.column === 'full') {
      flush();
      out.push(line);
      continue;
    }
    band.push(line);
  }
  flush();
  return out;
}

const isHeadingLine = (line: Line, body: number): boolean => line.size >= HEADING_FACTOR * body && line.text.length <= HEADING_MAX_CHARS;

/** §6.1.6's join rule: a trailing hyphen before a lowercase continuation is a word broken across
 * lines; a hyphen before anything else (a compound, a capitalised name) is part of the word. */
function joinInto(text: string, next: string): string {
  if (text.endsWith('-') && /^[a-z]/.test(next)) return `${text.slice(0, -1)}${next}`;
  return `${text} ${next}`;
}

function draftsOfPage(ordered: Line[], body: number): Draft[] {
  const out: Draft[] = [];
  let prev: Line | undefined;
  let text = '';
  let size = 0;
  let page = 0;

  const flush = (): void => {
    if (text === '') return;
    // §6.1.7: a big short block is a heading, anything else long enough is a passage, the rest is
    // dropped — a stray line of page furniture never becomes something to judge.
    if (size >= HEADING_FACTOR * body && text.length <= HEADING_MAX_CHARS) out.push({ kind: 'heading', text, page, size });
    else if (text.length >= MIN_PASSAGE_CHARS) out.push({ kind: 'passage', text, page, size });
    text = '';
  };

  for (const line of ordered) {
    const starts =
      prev === undefined ||
      prev.column !== line.column ||
      prev.y - line.y > GAP_FACTOR * prev.size ||
      Math.abs(line.size - prev.size) > SIZE_STEP ||
      isHeadingLine(line, body);
    if (starts) {
      flush();
      text = line.text;
      size = line.size;
      page = line.page;
    } else {
      text = joinInto(text, line.text);
    }
    prev = line;
  }
  flush();
  return out;
}

/** The whole of §6.1. `fallbackTitle` is the PDF's metadata title, else the file name (§6.1.8). */
export function pagesToBlocks(pages: PageText[], fallbackTitle: string): PdfDoc {
  const perPage = pages.map((page) => linesOf(page));
  const allLines = perPage.flat();
  const body = bodySize(allLines);
  const drop = runningFilter(allLines, pages.length);

  const drafts: Draft[] = [];
  for (const lines of perPage) drafts.push(...draftsOfPage(readingOrder(lines.filter((l) => !drop(l))), body));

  let title = fallbackTitle;
  let titleSize = -1;
  for (const draft of drafts) {
    if (draft.page !== 1 || draft.text.length < TITLE_MIN_CHARS || draft.size <= titleSize) continue;
    title = draft.text;
    titleSize = draft.size;
  }

  // Headings cost nothing against the cap: they are navigation for the reader, never judged.
  const blocks: Block[] = [];
  let passages = 0;
  for (const draft of drafts) {
    if (draft.kind === 'passage') {
      if (passages >= MAX_PASSAGES) continue;
      passages += 1;
    }
    blocks.push({ kind: draft.kind, text: draft.text, page: draft.page });
  }
  return { title, blocks };
}
```

- [ ] **Step 5: Run the geometry tests to verify they pass**

Run: `pnpm vitest run tests/unit/extension/pdf-text.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Write the fixture generator `tests/e2e/fixtures/make-sample-pdf.mjs`**

A complete PDF writer: eight objects, byte offsets tracked as it goes, and a real 20-byte-per-entry xref table. Deterministic — no dates, no randomness — so re-running it produces byte-identical output.

```js
// Writes tests/e2e/fixtures/sample.pdf: a two-page paper with a running header, page numbers, an
// 18 pt title, a 14 pt heading per page and 10 pt body paragraphs at 14 pt leading with 24 pt gaps.
// Every one of those exists to exercise one rule of reading mode's PDF geometry (design addendum
// §6.1), and the file is committed so the tests never depend on this script having been run.
//
// Hand-built rather than produced by a library: a library would add a creation date (so the bytes
// would change on every run), and the point of the fixture is that its glyph positions are exactly
// the ones written here. Run with `pnpm fixtures:pdf`.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.pdf');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 72;
const HEADER_Y = 770;
const NUMBER_Y = 40;
const TITLE_SIZE = 18;
const HEADING_SIZE = 14;
const BODY_SIZE = 10;
const LEADING = 14;
const PARAGRAPH_GAP = 24;
const TITLE_GAP = 40;
const HEADING_GAP = 30;
const RUNNING_HEADER = 'Sample Paper - draft';

// Each paragraph is written as the lines it is broken into, because that is what a PDF stores: the
// extractor's job is to put them back together (and to rejoin "positional"/"information" across the
// line break without inventing a space).
const PAGES = [
  {
    startY: 720,
    blocks: [
      { kind: 'title', text: 'Sample Paper' },
      { kind: 'heading', text: '1 Introduction' },
      {
        kind: 'paragraph',
        lines: [
          'We describe a small sample document used to exercise the text layout',
          'extraction path of a reading assistant. It has two pages, one running',
          'header, numbered pages, and paragraphs long enough to be judged.',
        ],
      },
      {
        kind: 'paragraph',
        lines: [
          'The document is generated by a script rather than by a word processor,',
          'so every glyph position in it is fixed and the same bytes are produced',
          'on every machine that runs the generator.',
        ],
      },
      {
        kind: 'paragraph',
        lines: [
          'Nothing in this file is a real research result. The sentences exist to',
          'give the extraction rules something with real line breaks, real gaps,',
          'and a heading above them to separate one block from the next.',
        ],
      },
      {
        kind: 'paragraph',
        lines: [
          'A reader that keeps paragraphs intact should return each of these four',
          'blocks as a single passage rather than as a handful of stray lines.',
        ],
      },
    ],
  },
  {
    startY: 730,
    blocks: [
      { kind: 'heading', text: '2 Method' },
      {
        kind: 'paragraph',
        lines: [
          'The method encodes each input token as a vector, adds a positional',
          'signal to it, and then applies a stack of attention layers in which',
          'every position attends to every other position of the same sequence.',
        ],
      },
      {
        kind: 'paragraph',
        lines: [
          'Positional information is represented by fixed sinusoidal functions of',
          'the position index, one frequency per embedding dimension, so that a',
          'relative offset between two positions is a linear function of them.',
        ],
      },
      {
        kind: 'paragraph',
        lines: [
          'Each layer is followed by a residual connection and layer',
          'normalisation, which keeps the scale of the activations stable as the',
          'depth of the stack grows.',
        ],
      },
      { kind: 'heading', text: '3 Acknowledgments' },
      {
        kind: 'paragraph',
        lines: [
          'We thank our colleagues for their comments on an earlier draft, the',
          'reviewers for their careful reading, and the maintainers of the open',
          'source libraries this work depends on.',
        ],
      },
    ],
  },
];

/** `1 0 0 1 x y Tm` puts the next string at an absolute point, so pdf.js reports transform[4]/[5] as
 * exactly the x/y written here and hypot(transform[1], transform[3]) as exactly the font size. */
const escape = (text) => text.replace(/([\\()])/g, '\\$1');

function contentStream(pageSpec, pageNumber) {
  const parts = ['BT'];
  const draw = (text, x, y, size) => parts.push(`/F1 ${size} Tf`, `1 0 0 1 ${x} ${y} Tm`, `(${escape(text)}) Tj`);

  draw(RUNNING_HEADER, LEFT, HEADER_Y, BODY_SIZE);
  let y = pageSpec.startY;
  for (const block of pageSpec.blocks) {
    if (block.kind === 'title' || block.kind === 'heading') {
      const size = block.kind === 'title' ? TITLE_SIZE : HEADING_SIZE;
      draw(block.text, LEFT, y, size);
      y -= block.kind === 'title' ? TITLE_GAP : HEADING_GAP;
      continue;
    }
    for (const line of block.lines) {
      draw(line, LEFT, y, BODY_SIZE);
      y -= LEADING;
    }
    y -= PARAGRAPH_GAP - LEADING; // the next paragraph starts a full gap below the last line drawn
  }
  draw(String(pageNumber), LEFT, NUMBER_Y, BODY_SIZE);
  parts.push('ET');
  return parts.join('\n');
}

// Object numbers are fixed up front so every reference can be written before its target exists.
const CATALOG = 1;
const PAGES_NODE = 2;
const PAGE_1 = 3;
const CONTENT_1 = 4;
const PAGE_2 = 5;
const CONTENT_2 = 6;
const FONT = 7;
const INFO = 8;
const OBJECT_COUNT = 9; // the eight objects plus entry 0, which is always the free-list head

const chunks = [];
const offsets = [];
let offset = 0;

function push(text) {
  // Everything written here is ASCII, so latin1 keeps one byte per character and the offsets below
  // stay exact — which is the entire contract of an xref table.
  const buf = Buffer.from(text, 'latin1');
  chunks.push(buf);
  offset += buf.length;
}

function pushObject(number, body) {
  offsets[number] = offset;
  push(`${number} 0 obj\n${body}\nendobj\n`);
}

function streamObject(number, stream) {
  pushObject(number, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
}

const pageObject = (parent, contents) =>
  `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
  `/Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contents} 0 R >>`;

push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'); // the binary comment marks the file as binary for transfer tools
pushObject(CATALOG, `<< /Type /Catalog /Pages ${PAGES_NODE} 0 R >>`);
pushObject(PAGES_NODE, `<< /Type /Pages /Kids [${PAGE_1} 0 R ${PAGE_2} 0 R] /Count 2 >>`);
pushObject(PAGE_1, pageObject(PAGES_NODE, CONTENT_1));
streamObject(CONTENT_1, contentStream(PAGES[0], 1));
pushObject(PAGE_2, pageObject(PAGES_NODE, CONTENT_2));
streamObject(CONTENT_2, contentStream(PAGES[1], 2));
pushObject(FONT, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
pushObject(INFO, '<< /Title (Sample Paper) /Producer (jev-duo make-sample-pdf) >>');

// The cross-reference table: one 20-byte entry per object, entry 0 free, then the trailer and the
// byte offset of the table itself.
const xrefOffset = offset;
push(`xref\n0 ${OBJECT_COUNT}\n`);
push('0000000000 65535 f \n');
for (let n = 1; n < OBJECT_COUNT; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
push(`trailer\n<< /Size ${OBJECT_COUNT} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

await writeFile(OUT, Buffer.concat(chunks));
console.log(`make-sample-pdf: wrote ${path.relative(process.cwd(), OUT)} (${offset} bytes)`);
```

- [ ] **Step 7: Generate the fixture and check it is a real PDF**

Run: `pnpm fixtures:pdf`
Expected: `make-sample-pdf: wrote tests/e2e/fixtures/sample.pdf (<n> bytes)`.
Run: `node -e "const b=require('fs').readFileSync('tests/e2e/fixtures/sample.pdf','latin1'); console.log(b.slice(0,8), b.includes('xref'), b.trimEnd().endsWith('%%EOF'))"`
Expected: `%PDF-1.4 true true`.
Run it a second time and confirm the bytes are identical: `pnpm fixtures:pdf && git diff --stat tests/e2e/fixtures/sample.pdf` — Expected: no diff on the second run.

- [ ] **Step 8: Write the failing test `tests/unit/extension/pdf-load.test.ts`**

```ts
// The one test that runs real pdf.js: the legacy build, in Node, with no DOM and no canvas, over the
// committed fixture. Everything else about the PDF path is driven from synthetic PageText, so this is
// specifically the "do our transform/view readings match what pdf.js actually reports?" test.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPages, type PdfjsLike } from '../../../src/extension/reading/pdf-load';
import { pagesToBlocks } from '../../../src/extension/reading/pdf-text';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures');

/** The specifier goes through a variable so TypeScript does not try to type-resolve a .mjs build that
 * ships no declarations; the shape it has to satisfy is asserted by `PdfjsLike` right here. */
async function legacyPdfjs(): Promise<PdfjsLike> {
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  return (await import(specifier)) as unknown as PdfjsLike;
}

async function sampleBytes(): Promise<ArrayBuffer> {
  const file = await readFile(path.join(FIXTURES, 'sample.pdf'));
  return Uint8Array.from(file).buffer; // a copy, sized exactly: Buffer's own ArrayBuffer is pooled
}

describe('loadPages on tests/e2e/fixtures/sample.pdf', () => {
  it('reads two letter-sized pages, their metadata title and unrotated items', async () => {
    const { pages, metaTitle } = await loadPages(await sampleBytes(), await legacyPdfjs());

    expect(metaTitle).toBe('Sample Paper');
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].width).toBe(612);
    expect(pages[0].height).toBe(792);
    expect(pages[0].items.length).toBeGreaterThan(10);
    expect(pages[0].items.every((i) => !i.rotated)).toBe(true);
    expect(pages[0].items.some((i) => Math.round(i.size) === 18)).toBe(true); // the title
    expect(pages[0].items.some((i) => Math.round(i.size) === 10)).toBe(true); // the body
  });

  it('rebuilds the paper: the right title, at least six passages, no running header in any of them', async () => {
    const { pages, metaTitle } = await loadPages(await sampleBytes(), await legacyPdfjs());
    const doc = pagesToBlocks(pages, metaTitle ?? 'sample.pdf');

    expect(doc.title).toBe('Sample Paper');
    const passages = doc.blocks.filter((b) => b.kind === 'passage');
    expect(passages.length).toBeGreaterThanOrEqual(6);
    expect(passages.every((b) => !b.text.includes('Sample Paper - draft'))).toBe(true);
    expect(passages.every((b) => b.text.length >= 40)).toBe(true);
    expect(new Set(passages.map((b) => b.page))).toEqual(new Set([1, 2]));

    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual([
      'Sample Paper',
      '1 Introduction',
      '2 Method',
      '3 Acknowledgments',
    ]);
    // The line break inside "positional information" is rejoined with a space, and no paragraph is
    // left as a stray single line.
    expect(passages.some((b) => b.text.includes('Positional information is represented by fixed sinusoidal functions of the position index'))).toBe(true);
  });
});
```

- [ ] **Step 9: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/extension/pdf-load.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/reading/pdf-load"`.

- [ ] **Step 10: Write `src/extension/reading/pdf-load.ts`**

```ts
// The one file that talks to pdf.js (design addendum §6.2), and it does so through an injected module
// rather than an import: the browser build (`pdfjs-dist`, bundled into the reader page) and the Node
// legacy build (`pdfjs-dist/legacy/build/pdf.mjs`, used by the unit test) behave identically here, and
// neither one belongs in a unit test's dependency graph by force. Everything downstream of this file
// sees PageText and nothing else.
//
// The shapes below are the narrowest both builds satisfy, narrowed again at runtime: pdf.js's own
// .d.ts types are far more specific than what this needs, and pinning to them would make a pdfjs-dist
// patch release able to break `pnpm typecheck`.

import type { PageText, TextItem } from './pdf-text';

export interface PdfPageLike {
  /** [x0, y0, x1, y1] in PDF user space. */
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<unknown>;
  destroy?(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One pdf.js text item -> one TextItem. Marked-content items (`{ type: 'beginMarkedContent' }`) carry
 * no transform at all and are skipped, which is why the return type is optional. */
function toTextItem(raw: unknown): TextItem | undefined {
  const item = raw as { str?: unknown; width?: unknown; transform?: unknown };
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6) return undefined;
  return {
    str: typeof item.str === 'string' ? item.str : '',
    x: num(t[4]),
    y: num(t[5]),
    // For an unrotated matrix [s, 0, 0, s, x, y] this is exactly the font size.
    size: Math.hypot(num(t[1]), num(t[3])),
    width: num(item.width),
    rotated: Math.abs(num(t[1])) > 0.01 || Math.abs(num(t[2])) > 0.01,
  };
}

function metaTitleOf(meta: unknown): string | undefined {
  const info = (meta as { info?: { Title?: unknown } } | undefined)?.info;
  const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
  return title === '' ? undefined : title;
}

/** `isEvalSupported: false` keeps pdf.js from compiling font programs with `eval` (the extension CSP
 * forbids it anyway); `useSystemFonts: false` keeps it from reaching for local fonts it does not need
 * to report text positions. The document is destroyed either way, so neither the reader page nor a
 * Node test is left holding a live worker. */
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const view = page.view;
      pages.push({
        page: n,
        width: num(view[2]) - num(view[0]),
        height: num(view[3]) - num(view[1]),
        items: content.items.map(toTextItem).filter((i): i is TextItem => i !== undefined),
      });
    }
    return { pages, metaTitle: metaTitleOf(await doc.getMetadata()) };
  } finally {
    await doc.destroy?.();
  }
}
```

- [ ] **Step 11: Run the loader test to verify it passes**

Run: `pnpm vitest run tests/unit/extension/pdf-load.test.ts`
Expected: PASS (2 tests). If pdf.js logs a warning about standard font data, ignore it: the 14 standard fonts' metrics are built in, which is all `item.width` needs.

- [ ] **Step 12: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 13: Commit**

```bash
git add package.json pnpm-lock.yaml src/extension/reading/pdf-text.ts src/extension/reading/pdf-load.ts \
        tests/e2e/fixtures/make-sample-pdf.mjs tests/e2e/fixtures/sample.pdf \
        tests/unit/extension/pdf-text.test.ts tests/unit/extension/pdf-load.test.ts
git commit -m "$(cat <<'EOF'
feat(extension): PDF text geometry and pdf.js loading

Positioned strings back into lines, columns, blocks and headings, with the
running header and the page numbers dropped — pure, so every rule is driven
from synthetic input. pdf.js is injected, so the browser build and the Node
legacy build share one loader, checked against a committed two-page fixture
whose generator is deterministic and rerunnable.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Read this page — settings, background, the reader UI and the popup

**Files:**
- Create: `src/extension/reading/reader-ui.ts`, `src/extension/reading/run.ts`, `src/extension/read-page.ts`, `tests/unit/extension/reader-ui.test.ts`, `tests/e2e/reading.spec.ts`
- Modify: `src/extension/messages.ts` (`Settings.focus`, `DEFAULT_SETTINGS.focus`, the `readPassages` request/response), `src/extension/background.ts` (the handler and the judge's lifetime), `src/extension/popup/popup.html` (the new section), `src/extension/popup/popup.ts`, `src/extension/popup/popup.css`, `scripts/build.mjs` (the `read-page.js` entry and its footer), `tests/unit/extension/chrome-stub.ts` (`tabs.query({url})`, `tabs.create`, `scripting.executeScript`), `tests/unit/extension/background.test.ts`, `tests/unit/extension/popup.test.ts` (the `Settings` literal gains `focus`)
- Test: `reader-ui.test.ts`, new cases in `background.test.ts` and `popup.test.ts`, and the new `reading.spec.ts`

**Interfaces:**
- Consumes: `DocContext`, `Passage`, `ReadingVerdict` (Task 1); `ReadingJudge` with `judge(ctx, focus, passages, onVerdict?): Promise<ReadingRun>` (Task 1); `extractArticle(doc)`, `articleCandidates(doc)`, `ArticlePassage`, `Article` (Task 2); `JEV_INPUT_USD_PER_MTOK = 0.042` (`src/core/constants.ts`); `send<R extends Request>(req: R)` (`src/extension/messages.ts`).
- Produces, in `src/extension/messages.ts`: `Settings.focus: string` (default `''`); `Request` gains `{ type: 'readPassages'; ctx: DocContext; passages: Passage[] }`; `Response` gains `{ ok: true; type: 'readPassages'; focus: string; verdicts: ReadingVerdict[]; usageTokens: number; errors: number }`.
- Produces, from `src/extension/reading/reader-ui.ts`: `const READER_CSS: string`; `interface ReaderHandle { apply(v: ReadingVerdict): void; setFocus(focus: string): void; setProgress(judged: number, total: number): void; finish(summary: { ms: number; usageTokens: number; errors: number }): void; destroy(): void }`; `mountReader(host: Document, opts: { passages: ArticlePassage[]; focus: string; onClose(): void }): ReaderHandle`.
- Produces, from `src/extension/reading/run.ts`: `const READ_BATCH = 12`; `runReading(deps: { handle: ReaderHandle; ctx: DocContext; passages: Passage[]; send: typeof send; batchSize?: number; now?: () => number }): Promise<{ ms: number; usageTokens: number; errors: number }>`.
- Produces, from `src/extension/read-page.ts`: `type ReadResult = { state: 'started'; passages: number } | { state: 'stopped' } | { state: 'no-article'; passages: number }` (imported `import type` by the popup) and, at runtime, `globalThis.__jevDuoReader` / `globalThis.__jevDuoReadResult`.
- Produces for Task 5: everything above, plus `dist/extension/read-page.js` built with the esbuild footer.

- [ ] **Step 1: Write the failing background tests**

Append to `tests/unit/extension/background.test.ts`, inside the top-level `describe('background', ...)`:

```ts
  // --- Reading mode (design addendum §9): one handler, no gate, its own judge ---

  describe('readPassages', () => {
    const ctx = { title: 'Sample Paper', lead: 'A lead.', source: 'https://example.test/p' };
    const passage = (id: string, text: string) => ({ id, index: 0, text });

    it('judges the passages with the mock provider and honours fixtures keyed by passage id', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'setSettings', patch: { providerMode: 'mock', mockFixtures: { 'rd:1': { core: 0.95 }, 'rd:2': { core: 0.05 } } } });

      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'a substantive claim'), passage('rd:2', 'boilerplate')] });

      expect(res.ok).toBe(true);
      if (!res.ok || res.type !== 'readPassages') throw new Error('expected a readPassages response');
      expect(res.verdicts.map((v) => v.verdict)).toEqual(['highlight', 'dim']);
      expect(res.errors).toBe(0);
      expect(res.focus).toBe('');
    });

    it('applies settings.focus and reports it back to the reader', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'setSettings', patch: { focus: 'how is position represented', mockFixtures: { 'rd:1': { core: 0.1, focus: 0.9 } } } });

      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'sinusoidal position encodings')] });

      if (!res.ok || res.type !== 'readPassages') throw new Error('expected a readPassages response');
      expect(res.focus).toBe('how is position represented');
      // Highlighted on the focus probability alone, with a core well under the no-focus threshold.
      expect(res.verdicts[0]).toMatchObject({ verdict: 'highlight', focus: 0.9, core: 0.1 });
    });

    it('is available to a content-script sender: reading carries no secrets', async () => {
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'some text')] }, { tab: { id: 3 }, origin: 'https://example.test' });
      expect(res.ok).toBe(true);
    });

    it('needs no compiled pack, unlike judge', async () => {
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'some text')] });
      expect(res.ok).toBe(true);
    });

    it('caches a passage across calls while the provider is unchanged', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'setSettings', patch: { mockFixtures: { 'rd:1': { core: 0.95 } } } });
      await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'stable text')] });

      // A new fixture for the same passage: the cached verdict wins, because the judge (and its cache)
      // survives a settings change that cannot have changed the provider.
      await bg.handle({ type: 'setSettings', patch: { mockFixtures: { 'rd:1': { core: 0.05 } } } });
      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'stable text')] });

      if (!res.ok || res.type !== 'readPassages') throw new Error('expected a readPassages response');
      expect(res.verdicts[0].core).toBe(0.95);
    });

    it('throws the judge away when a key changes, so nothing is served from the old provider', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'setSettings', patch: { mockFixtures: { 'rd:1': { core: 0.95 } } } });
      await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'stable text')] });

      // providerMode stays mock (so nothing goes near the network), but a key changed — which is
      // exactly what providersMayHaveChanged looks at, and what must drop the reading cache.
      await bg.handle({ type: 'setSettings', patch: { keys: { typesafe: 'ts-key' }, mockFixtures: { 'rd:1': { core: 0.05 } } } });
      const res = await bg.handle({ type: 'readPassages', ctx, passages: [passage('rd:1', 'stable text')] });

      if (!res.ok || res.type !== 'readPassages') throw new Error('expected a readPassages response');
      expect(res.verdicts[0].core).toBe(0.05);
    });
  });
```

- [ ] **Step 2: Run them to watch them fail**

Run: `pnpm vitest run tests/unit/extension/background.test.ts`
Expected: FAIL — TypeScript rejects `{ type: 'readPassages', ... }` as not assignable to `Request`.

- [ ] **Step 3: Extend `src/extension/messages.ts`**

1. Add to the imports at the top:

```ts
import type { DocContext, Passage, ReadingVerdict } from '../core/reading';
```

2. Add the field to `Settings`, after `arbiter`:

```ts
  focus: string; // reading mode's "what are you looking for?", inlined into the focus question; default ''
```

3. Add to `DEFAULT_SETTINGS`, after `arbiter: true,`:

```ts
  focus: '',
```

4. Add to the `Request` union, after the `disableSite` member:

```ts
  // Reading mode (design addendum §9). Unlike `judge` this needs no compiled pack and is not gated by
  // enabledSites/genericSites: the user clicked Read on this document, and the click is the consent.
  // Any sender may call it — the reply carries probabilities about text the sender already has.
  | { type: 'readPassages'; ctx: DocContext; passages: Passage[] }
```

5. Add to the `Response` union, before the `ok: false` member:

```ts
  // `focus` is the setting the background actually applied, echoed so the reader panel can show the
  // question the verdicts answer without reading Settings itself (a content script may not).
  | { ok: true; type: 'readPassages'; focus: string; verdicts: ReadingVerdict[]; usageTokens: number; errors: number }
```

- [ ] **Step 4: Extend `src/extension/background.ts`**

1. Add the import, next to the other core imports:

```ts
import { ReadingJudge } from '../core/reading-judge';
import type { DocContext, Passage } from '../core/reading';
```

2. Add the two closure variables next to `let cache: LruCache<Verdict>;`:

```ts
  // Reading mode's judge (design addendum §9). Its cache key is title|focus|passage text and carries
  // no provider identity — the same reason the verdict cache above is dropped when the provider
  // changes — so the whole judge is replaced rather than invalidated. `stale` starts true so the
  // first buildAgent creates one.
  let readingJudge: ReadingJudge;
  let readingJudgeStale = true;
```

3. In `buildAgent`, right after `providers = { jev: resolved.jev.name, llm: resolved.llm.name };`:

```ts
    if (readingJudgeStale) {
      readingJudge = new ReadingJudge(resolved.jev);
      readingJudgeStale = false;
    }
```

4. In `handleSetSettings`, inside the `if (providersMayHaveChanged(before, saved))` block, after `await saveVerdicts([]);`:

```ts
      readingJudgeStale = true; // the reading cache has no provider identity either (§9)
```

5. Add the handler next to `handleJudge`:

```ts
  /** Reading mode's only handler (§9). Deliberately not queued behind the mutation queue and not
   * gated on a pack: a reader waiting on a batch of twelve passages must not sit behind a recompile.
   * `settings.focus` is read here, not passed in, so every reader — the injected one and the PDF page
   * — asks the same question, and the answer says which one it was. */
  async function handleReadPassages(ctx: DocContext, passages: Passage[]): Promise<Response> {
    const focus = settings.focus;
    const { verdicts, usageTokens, errors } = await readingJudge.judge(ctx, focus, passages);
    return { ok: true, type: 'readPassages', focus, verdicts, usageTokens, errors };
  }
```

6. Add the case to `dispatch`, next to `case 'judge':`:

```ts
      case 'readPassages':
        return handleReadPassages(req.ctx, req.passages);
```

- [ ] **Step 5: Run the background tests to verify they pass**

Run: `pnpm vitest run tests/unit/extension/background.test.ts`
Expected: PASS — the six new cases plus every existing one.

- [ ] **Step 6: Fix the one `Settings` literal the new field breaks**

In `tests/unit/extension/popup.test.ts`, add `focus: '',` to the `SETTINGS` constant (after `arbiter: true,`).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Write the failing tests `tests/unit/extension/reader-ui.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DocContext, Passage, ReadingVerdict } from '../../../src/core/reading';
import type { ArticlePassage } from '../../../src/extension/reading/article';
import { mountReader, READER_CSS } from '../../../src/extension/reading/reader-ui';
import { runReading } from '../../../src/extension/reading/run';
import type { Request, Response, send } from '../../../src/extension/messages';

/** A document with `n` paragraphs, returned as the ArticlePassage list a reader would mount. */
function docWith(n: number, opts: { pages?: boolean } = {}): { doc: Document; passages: ArticlePassage[] } {
  const doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
  const passages: ArticlePassage[] = [];
  for (let i = 0; i < n; i++) {
    const el = doc.createElement('p');
    el.id = `p${i}`;
    el.textContent = `Passage number ${i} with quite a lot of text in it so the snippet is truncated somewhere sensible.`;
    doc.body.appendChild(el);
    passages.push({ id: `rd:${i}`, index: i, text: el.textContent ?? '', el, ...(opts.pages ? { page: i + 1 } : {}) });
  }
  return { doc, passages };
}

const verdict = (id: string, v: ReadingVerdict['verdict'], extra: Partial<ReadingVerdict> = {}): ReadingVerdict => ({
  id,
  verdict: v,
  p: 0.82,
  core: 0.82,
  ...extra,
});

const panelOf = (doc: Document): ShadowRoot => {
  const root = doc.getElementById('jd-reader')?.shadowRoot;
  if (!root) throw new Error('test: no reader panel');
  return root;
};

describe('mountReader decorations', () => {
  it('highlights, tags, dims and leaves plain passages alone', () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:0', 'highlight', { kind: 'method' }));
    handle.apply(verdict('rd:1', 'dim'));
    handle.apply(verdict('rd:2', 'plain'));

    expect(passages[0].el.classList.contains('jd-hl')).toBe(true);
    expect(passages[0].el.querySelector('.jd-rtag')?.textContent).toBe('method · 82%');
    expect(passages[1].el.classList.contains('jd-dim')).toBe(true);
    expect(passages[2].el.className).toBe('');
    expect(passages[2].el.querySelector('.jd-rtag')).toBeNull();
  });

  it('tags a highlight with no kind as the percentage alone', () => {
    const { doc, passages } = docWith(1);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:0', 'highlight', { p: 0.9 }));
    expect(passages[0].el.querySelector('.jd-rtag')?.textContent).toBe('90%');
  });

  it('injects READER_CSS once, under a stable id', () => {
    const { doc, passages } = docWith(1);
    mountReader(doc, { passages, focus: '', onClose: () => {} });
    const styles = doc.querySelectorAll('#jd-reader-style');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(READER_CSS);
    expect(READER_CSS).toContain('opacity: .35 !important');
  });

  it('ignores a verdict for a passage it does not have', () => {
    const { doc, passages } = docWith(1);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    expect(() => handle.apply(verdict('rd:nope', 'highlight'))).not.toThrow();
    expect(panelOf(doc).querySelectorAll('li')).toHaveLength(0);
  });
});

describe('mountReader panel', () => {
  it('lists only the highlights, in document order however the verdicts arrive', () => {
    const { doc, passages } = docWith(4);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:3', 'highlight', { kind: 'result' }));
    handle.apply(verdict('rd:1', 'highlight', { kind: 'claim' }));
    handle.apply(verdict('rd:2', 'dim'));
    handle.apply(verdict('rd:0', 'highlight', { kind: 'method' }));

    const items = [...panelOf(doc).querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items.map((t) => t.split(' · ')[0])).toEqual(['method', 'claim', 'result']);
    expect(items[0]).toBe('method · Passage number 0 with quite a lot of text in it so the snippet is trunc…');
  });

  it('prefixes a page number when the passage has one', () => {
    const { doc, passages } = docWith(2, { pages: true });
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:1', 'highlight', { kind: 'claim' }));
    expect(panelOf(doc).querySelector('li')?.textContent?.startsWith('p. 2 · claim · ')).toBe(true);
  });

  it('shows the focus line only when there is a focus', () => {
    const { doc, passages } = docWith(1);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('');

    handle.setFocus('why does it work');
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('focus: why does it work');
  });

  it('counts progress, then replaces it with the summary line', () => {
    const { doc, passages } = docWith(12);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.setProgress(6, 12);
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('6 of 12 judged');

    handle.finish({ ms: 3450, usageTokens: 120_000, errors: 0 });
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('12 passages · 3.5 s · ~$0.0050');
  });

  it('appends the error count to the summary only when there were errors', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 3 });
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('2 passages · 1.0 s · ~$0.0000 · 3 errors');
  });

  it('Show all removes every dim and relabels itself; Dim again puts them back', () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    handle.apply(verdict('rd:0', 'dim'));
    handle.apply(verdict('rd:1', 'dim'));

    const button = [...panelOf(doc).querySelectorAll('button')].find((b) => b.textContent === 'Show all');
    button?.click();
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(0);
    expect(button?.textContent).toBe('Dim again');

    // A verdict that lands while everything is shown must not re-dim behind the user's back.
    handle.apply(verdict('rd:2', 'dim'));
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(0);

    button?.click();
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(3);
    expect(button?.textContent).toBe('Show all');
  });

  it('scrolls and flashes the passage a list item points at', () => {
    vi.useFakeTimers();
    const { doc, passages } = docWith(1);
    const scrollIntoView = vi.fn();
    Object.assign(passages[0].el, { scrollIntoView }); // jsdom has no scrollIntoView of its own
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:0', 'highlight'));

    panelOf(doc).querySelector('li')?.dispatchEvent(new doc.defaultView!.MouseEvent('click'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(passages[0].el.classList.contains('jd-flash')).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(passages[0].el.classList.contains('jd-flash')).toBe(false);
    vi.useRealTimers();
  });
});

describe('mountReader lifecycle', () => {
  it('destroy restores the DOM, removes the style and calls onClose', () => {
    const { doc, passages } = docWith(2);
    const onClose = vi.fn();
    const handle = mountReader(doc, { passages, focus: '', onClose });
    handle.apply(verdict('rd:0', 'highlight', { kind: 'claim' }));
    handle.apply(verdict('rd:1', 'dim'));

    handle.destroy();

    expect(doc.getElementById('jd-reader')).toBeNull();
    expect(doc.getElementById('jd-reader-style')).toBeNull();
    expect(doc.querySelectorAll('.jd-hl, .jd-dim, .jd-rtag')).toHaveLength(0);
    expect(doc.body.innerHTML).toContain('Passage number 0');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('both Close buttons destroy the panel', () => {
    for (const label of ['×', 'Close']) {
      const { doc, passages } = docWith(1);
      mountReader(doc, { passages, focus: '', onClose: () => {} });
      [...panelOf(doc).querySelectorAll('button')].find((b) => b.textContent === label)?.click();
      expect(doc.getElementById('jd-reader')).toBeNull();
    }
  });

  it('a second mountReader destroys the first', () => {
    const { doc, passages } = docWith(2);
    const onClose = vi.fn();
    const first = mountReader(doc, { passages, focus: '', onClose });
    first.apply(verdict('rd:0', 'highlight'));

    mountReader(doc, { passages, focus: '', onClose: () => {} });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(doc.querySelectorAll('#jd-reader')).toHaveLength(1);
    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(0);
  });
});

describe('runReading', () => {
  const ctx: DocContext = { title: 'T', lead: 'L', source: 'https://example.test/p' };

  /** A `send` that answers every readPassages batch by highlighting the first passage in it. */
  function sendSpy(over: (req: Request) => Response | undefined = () => undefined) {
    const calls: Request[] = [];
    const fn = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(structuredClone(req));
      const custom = over(req);
      if (custom) return custom;
      if (req.type !== 'readPassages') return { ok: false, error: 'unhandled' };
      return {
        ok: true,
        type: 'readPassages',
        focus: 'the question',
        verdicts: req.passages.map((p, i) => verdict(p.id, i === 0 ? 'highlight' : 'plain')),
        usageTokens: 10 * req.passages.length,
        errors: 0,
      };
    });
    return { calls, send: fn as unknown as typeof send };
  }

  it('sends batches of twelve in document order, with no DOM in the message', async () => {
    const { doc, passages } = docWith(20);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const spy = sendSpy();

    const summary = await runReading({ handle, ctx, passages, send: spy.send });

    const batches = spy.calls.filter((c) => c.type === 'readPassages');
    expect(batches).toHaveLength(2);
    if (batches[0].type !== 'readPassages' || batches[1].type !== 'readPassages') throw new Error('expected readPassages');
    expect(batches[0].passages).toHaveLength(12);
    expect(batches[1].passages).toHaveLength(8);
    expect(batches[0].passages[0]).toEqual({ id: 'rd:0', index: 0, text: passages[0].text, page: undefined });
    expect(summary.usageTokens).toBe(200);
    expect(summary.errors).toBe(0);
  });

  it('applies each batch as it lands, shows the focus once, and finishes', async () => {
    const { doc, passages } = docWith(13);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    await runReading({ handle, ctx, passages, send: sendSpy().send });

    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(2); // one per batch
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('focus: the question');
    expect(panelOf(doc).querySelector('.progress')?.textContent).toMatch(/^13 passages · /);
  });

  it('counts a batch the background could not answer as errors, and applies nothing', async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    const summary = await runReading({ handle, ctx, passages, send: sendSpy(() => ({ ok: false, error: 'no response from background' })).send });

    expect(summary.errors).toBe(5);
    expect(doc.querySelectorAll('.jd-hl, .jd-dim')).toHaveLength(0);
    expect(panelOf(doc).querySelector('.progress')?.textContent).toContain('· 5 errors');
  });

  it('honours a smaller batch size', async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const spy = sendSpy();

    await runReading({ handle, ctx, passages, send: spy.send, batchSize: 2 });

    expect(spy.calls.filter((c) => c.type === 'readPassages')).toHaveLength(3);
  });
});
```

- [ ] **Step 8: Run it to watch it fail**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/extension/reading/reader-ui"`.

- [ ] **Step 9: Write `src/extension/reading/reader-ui.ts`**

```ts
// The reading panel and the passage decorations (design addendum §8.2). Shared by the reader injected
// into a page (read-page.ts) and the PDF reader page (reader/reader.ts), which is why it takes the
// host Document explicitly and speaks only DOM: no chrome.*, no messaging, no fetch. Judging happens
// in reading/run.ts and arrives here one verdict at a time through `apply`.
//
// Nothing is ever hidden (§2): a dimmed passage stays exactly where it was at 35 % opacity and comes
// back on hover, and one button brings all of them back at once. Highlights add, never remove.

import { JEV_INPUT_USD_PER_MTOK } from '../../core/constants';
import type { ReadingVerdict } from '../../core/reading';
import type { ArticlePassage } from './article';

/** The document-level sheet: the passage classes live in the page's own DOM, so they cannot live in
 * the panel's shadow root. `!important` throughout because the host page's CSS is not ours. */
export const READER_CSS = `
.jd-hl { box-shadow: inset 3px 0 0 #f2a900 !important; background: rgba(242,169,0,.10) !important; }
.jd-dim { opacity: .35 !important; transition: opacity .15s ease; }
.jd-dim:hover { opacity: 1 !important; }
.jd-flash { animation: jd-flash 1.2s ease-out 1; }
@keyframes jd-flash { from { outline: 2px solid #f2a900; outline-offset: 2px; } to { outline: 2px solid rgba(242,169,0,0); outline-offset: 2px; } }
.jd-rtag { font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #6b6b73; background: #f0f0f3; border-radius: 4px; margin-left: 6px; padding: 1px 6px; white-space: nowrap; vertical-align: middle; }
#jd-reader { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
`;

/** The panel's own sheet, inside its shadow root: not exported because nothing outside this file can
 * reach the elements it styles, and `all: initial` is what keeps the host page's CSS out. */
const PANEL_CSS = `
:host { all: initial; }
.panel { width: 320px; max-height: 50vh; display: flex; flex-direction: column; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #35353c; background: #fff; border: 1px solid #dcdce2; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; }
header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #dcdce2; }
header h2 { font-size: 12px; margin: 0; flex: 1; }
button { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #c8c8d0; background: #f0f0f3; color: #35353c; cursor: pointer; }
.x { border: none; background: none; font-size: 14px; line-height: 1; padding: 0 2px; }
.meta { color: #6b6b73; margin: 0; padding: 4px 10px; }
.meta:empty { display: none; }
ol { flex: 1; overflow-y: auto; margin: 0; padding: 0 10px 6px 26px; }
li { padding: 3px 0; cursor: pointer; }
li:hover { text-decoration: underline; }
footer { display: flex; gap: 8px; padding: 6px 10px; border-top: 1px solid #dcdce2; }
@media (prefers-color-scheme: dark) {
  .panel { color: #d6d6dc; background: #1c1c20; border-color: #3a3a41; }
  header, footer { border-color: #3a3a41; }
  button { background: #26262b; color: #d6d6dc; border-color: #3a3a41; }
  .meta { color: #a4a4ac; }
}
`;

export interface ReaderHandle {
  apply(v: ReadingVerdict): void;
  /** The background owns `Settings.focus`, so the panel learns it from the first reply (§9). */
  setFocus(focus: string): void;
  setProgress(judged: number, total: number): void;
  finish(summary: { ms: number; usageTokens: number; errors: number }): void;
  destroy(): void;
}

const STYLE_ID = 'jd-reader-style';
const PANEL_ID = 'jd-reader';
const FLASH_MS = 1200;
const SNIPPET_MAX = 80;

const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** At most one panel exists at a time, in one document: mounting again replaces it rather than
 * stacking two readers over the same passages. */
let current: ReaderHandle | undefined;

export function mountReader(host: Document, opts: { passages: ArticlePassage[]; focus: string; onClose(): void }): ReaderHandle {
  current?.destroy();

  const style = host.createElement('style');
  style.id = STYLE_ID;
  style.textContent = READER_CSS;
  (host.head ?? host.body).appendChild(style);

  const byId = new Map(opts.passages.map((p) => [p.id, p]));
  const tags: Element[] = [];
  const dimmed: Element[] = [];
  const listedIndexes: number[] = [];
  let showingAll = false;

  const panel = host.createElement('div');
  panel.id = PANEL_ID;
  const shadow = panel.attachShadow({ mode: 'open' });

  const panelStyle = host.createElement('style');
  panelStyle.textContent = PANEL_CSS;

  const wrap = host.createElement('div');
  wrap.className = 'panel';
  const head = host.createElement('header');
  const heading = host.createElement('h2');
  heading.textContent = 'jev-duo reader';
  const closeX = host.createElement('button');
  closeX.type = 'button';
  closeX.className = 'x';
  closeX.textContent = '×';
  head.append(heading, closeX);

  const focusLine = host.createElement('p');
  focusLine.className = 'meta focus';
  const progressLine = host.createElement('p');
  progressLine.className = 'meta progress';
  const list = host.createElement('ol');

  const foot = host.createElement('footer');
  const showAll = host.createElement('button');
  showAll.type = 'button';
  showAll.textContent = 'Show all';
  const close = host.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  foot.append(showAll, close);

  wrap.append(head, focusLine, progressLine, list, foot);
  shadow.append(panelStyle, wrap);
  host.body.appendChild(panel);

  function addToList(passage: ArticlePassage, v: ReadingVerdict): void {
    const snippet = passage.text.slice(0, SNIPPET_MAX) + (passage.text.length > SNIPPET_MAX ? '…' : '');
    const label = v.kind ? `${v.kind} · ${snippet}` : snippet;
    const li = host.createElement('li');
    li.textContent = passage.page === undefined ? label : `p. ${passage.page} · ${label}`;
    li.addEventListener('click', () => {
      // jsdom has no scrollIntoView, and neither does every embedded browser view — the panel must
      // still flash the passage when it cannot scroll to it.
      passage.el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      passage.el.classList.add('jd-flash');
      setTimeout(() => passage.el.classList.remove('jd-flash'), FLASH_MS);
    });

    // Verdicts arrive in whatever order the calls resolved; the list is always document order.
    const at = listedIndexes.findIndex((index) => index > passage.index);
    if (at === -1) {
      listedIndexes.push(passage.index);
      list.appendChild(li);
    } else {
      listedIndexes.splice(at, 0, passage.index);
      list.insertBefore(li, list.children[at]);
    }
  }

  function apply(v: ReadingVerdict): void {
    const passage = byId.get(v.id);
    if (!passage) return; // a verdict for a document that has already been replaced
    if (v.verdict === 'highlight') {
      passage.el.classList.add('jd-hl');
      const tag = host.createElement('span');
      tag.className = 'jd-rtag';
      tag.textContent = v.kind ? `${v.kind} · ${pct(v.p)}` : pct(v.p);
      passage.el.appendChild(tag);
      tags.push(tag);
      addToList(passage, v);
      return;
    }
    if (v.verdict !== 'dim') return; // plain passages are left exactly as the document rendered them
    dimmed.push(passage.el);
    if (!showingAll) passage.el.classList.add('jd-dim');
  }

  showAll.addEventListener('click', () => {
    showingAll = !showingAll;
    for (const el of dimmed) el.classList.toggle('jd-dim', !showingAll);
    showAll.textContent = showingAll ? 'Dim again' : 'Show all';
  });

  function destroy(): void {
    for (const passage of opts.passages) passage.el.classList.remove('jd-hl', 'jd-dim', 'jd-flash');
    for (const tag of tags) tag.remove();
    panel.remove();
    style.remove();
    if (current === handle) current = undefined;
    opts.onClose();
  }

  closeX.addEventListener('click', destroy);
  close.addEventListener('click', destroy);

  const handle: ReaderHandle = {
    apply,
    setFocus(focus: string): void {
      const trimmed = focus.trim();
      focusLine.textContent = trimmed === '' ? '' : `focus: ${trimmed}`;
    },
    setProgress(judged: number, total: number): void {
      progressLine.textContent = `${judged} of ${total} judged`;
    },
    finish(summary): void {
      const usd = ((summary.usageTokens * JEV_INPUT_USD_PER_MTOK) / 1e6).toFixed(4);
      const errors = summary.errors > 0 ? ` · ${summary.errors} errors` : '';
      progressLine.textContent = `${opts.passages.length} passages · ${(summary.ms / 1000).toFixed(1)} s · ~$${usd}${errors}`;
    },
    destroy,
  };

  handle.setFocus(opts.focus);
  current = handle;
  return handle;
}
```

- [ ] **Step 10: Write `src/extension/reading/run.ts`**

```ts
// The shared reading loop (design addendum §8.1 and §6.3): passages go to the background in document
// order, in batches, and each batch's verdicts are applied the moment it answers. Both readers — the
// one injected into a page and the PDF reader page — run exactly this, which is the only reason the
// two produce the same panel from the same judgments.
//
// This is the only file under reading/ that knows about messaging; reader-ui.ts stays pure DOM.

import type { DocContext, Passage } from '../../core/reading';
import type { send } from '../messages';
import type { ReaderHandle } from './reader-ui';

/** Twelve passages per message: small enough that the panel fills in while a long document is still
 * being read, large enough that a 600-passage document is 50 messages rather than 600. */
export const READ_BATCH = 12;

export async function runReading(deps: {
  handle: ReaderHandle;
  ctx: DocContext;
  passages: Passage[];
  send: typeof send;
  batchSize?: number;
  now?: () => number;
}): Promise<{ ms: number; usageTokens: number; errors: number }> {
  const { handle, ctx, passages } = deps;
  const size = deps.batchSize ?? READ_BATCH;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  let judged = 0;
  let usageTokens = 0;
  let errors = 0;
  let focusShown = false;

  handle.setProgress(0, passages.length);
  for (let i = 0; i < passages.length; i += size) {
    // Rebuilt field by field, which is also what strips an ArticlePassage's `el`: a DOM node cannot
    // be structured-cloned into a message, and the background has no use for one.
    const batch = passages.slice(i, i + size).map(({ id, index, text, page }) => ({ id, index, text, page }));
    const res = await deps.send({ type: 'readPassages', ctx, passages: batch });
    if (res.ok && res.type === 'readPassages') {
      if (!focusShown) {
        handle.setFocus(res.focus);
        focusShown = true;
      }
      for (const verdict of res.verdicts) handle.apply(verdict);
      usageTokens += res.usageTokens;
      errors += res.errors;
    } else {
      // Fail open (§2): a batch the background could not answer leaves its passages exactly as the
      // document rendered them, counted so the summary line admits it.
      errors += batch.length;
    }
    judged += batch.length;
    handle.setProgress(judged, passages.length);
  }

  const summary = { ms: now() - started, usageTokens, errors };
  handle.finish(summary);
  return summary;
}
```

- [ ] **Step 11: Run the reader-ui tests to verify they pass**

Run: `pnpm vitest run tests/unit/extension/reader-ui.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 12: Write `src/extension/read-page.ts`**

```ts
// Injected on demand by the popup (chrome.scripting.executeScript with files: ['read-page.js']) under
// activeTab — no host permission, no manifest change, nothing running until the user asks (§2). The
// same injection stops the reader the second time it runs, which is what makes Read this page a
// toggle rather than a switch that can only be turned on.
//
// Its COMPLETION VALUE is what executeScript hands back to the popup: scripts/build.mjs appends
// `globalThis.__jevDuoReadResult;` after the bundle (esbuild `footer.js`), so everything here assigns
// that global SYNCHRONOUSLY and nothing at the top level awaits. Judging continues afterwards.

import { send } from './messages';
import { articleCandidates, extractArticle } from './reading/article';
import { mountReader } from './reading/reader-ui';
import { runReading } from './reading/run';

export type ReadResult =
  | { state: 'started'; passages: number }
  | { state: 'stopped' }
  | { state: 'no-article'; passages: number };

interface ReaderGlobals {
  __jevDuoReader?: { destroy(): void };
  __jevDuoReadResult?: ReadResult;
}

const globals = globalThis as unknown as ReaderGlobals;

function run(): ReadResult {
  const existing = globals.__jevDuoReader;
  if (existing) {
    // Cleared before destroy() so the onClose below cannot resurrect a stale handle; destroy() itself
    // removes every class, tag and node the reader added.
    delete globals.__jevDuoReader;
    existing.destroy();
    return { state: 'stopped' };
  }

  const article = extractArticle(document);
  if (!article) {
    // Nothing is mounted: the popup says how many paragraphs were even considered, which is the
    // difference between "not an article" and "this page has no text yet".
    return { state: 'no-article', passages: articleCandidates(document).length };
  }

  const handle = mountReader(document, {
    passages: article.passages,
    // The background owns Settings.focus and a content script may not ask for it (getState is refused
    // to tabs), so the panel starts without one and runReading fills it in from the first reply.
    focus: '',
    onClose: () => {
      delete globals.__jevDuoReader;
    },
  });
  globals.__jevDuoReader = handle;

  void runReading({ handle, ctx: article.ctx, passages: article.passages, send }).catch((err: unknown) => {
    console.error('jev-duo reader: judging failed', err);
  });

  return { state: 'started', passages: article.passages.length };
}

globals.__jevDuoReadResult = run();
```

- [ ] **Step 13: Add the `read-page.js` entry to `scripts/build.mjs`**

Replace the `extEntries` array and the loop that follows it (lines 46-64) with:

```js
const extEntries = [
  { entry: 'background.ts', out: 'background.js', format: 'esm' },
  { entry: 'content.ts', out: 'content.js', format: 'iife' },
  { entry: path.join('popup', 'popup.ts'), out: 'popup.js', format: 'iife' },
  // The injected reader has to HAND ITS RESULT BACK to the popup: chrome.scripting.executeScript
  // resolves with the completion value of the injected file's last statement, and a bundle's last
  // statement is the IIFE call, whose value is undefined. esbuild's `footer.js` is inserted verbatim
  // after everything else (not minified, not part of the bundle's scope), so one more expression
  // statement reading the global the bundle just assigned is exactly what is needed. Verified against
  // esbuild 0.28.2, whose BuildOptions declares `footer?: { [type: string]: string }`.
  { entry: 'read-page.ts', out: 'read-page.js', format: 'iife', footer: { js: 'globalThis.__jevDuoReadResult;' } },
];
for (const { entry, out, format, footer } of extEntries) {
  const outfile = path.join(extDist, out);
  await build({
    entryPoints: [path.join(extSrc, entry)],
    outfile,
    bundle: true,
    platform: 'browser',
    format,
    target: 'chrome120',
    minify: true,
    ...(footer ? { footer } : {}),
    logLevel: 'warning',
  });
  outputs.push(rel(outfile));
}
```

Run: `pnpm build && tail -c 60 dist/extension/read-page.js`
Expected: the file ends with `globalThis.__jevDuoReadResult;`.

- [ ] **Step 14: Teach the chrome stub about tabs and scripting**

In `tests/unit/extension/chrome-stub.ts`:

1. Widen the tab shape and add a record of opened tabs, next to `let tabs: ...`:

```ts
  let tabs: Array<{ id?: number; url?: string; title?: string }> = [];
  const createdTabs: string[] = [];
```

2. Replace the `tabs` member of the object assigned to `globalThis.chrome`:

```ts
    tabs: {
      /** `query({url})` is how the popup's `?jd-tab=` hook names a tab instead of taking the active
       * one; every other query answers with whatever `setTabs` was given. */
      async query(info?: { url?: string }): Promise<Array<{ id?: number; url?: string; title?: string }>> {
        return info?.url === undefined ? tabs : tabs.filter((t) => t.url === info.url);
      },
      async create(props: { url: string }): Promise<{ id: number }> {
        createdTabs.push(props.url);
        return { id: 999 };
      },
    },
```

3. Add `executeScript` to the `scripting` object (after `getRegisteredContentScripts`):

```ts
    /** Injection always "succeeds" with no completion value; a test that cares spies on this and
     * resolves whatever ReadResult it wants to exercise. */
    async executeScript(): Promise<Array<{ result?: unknown }>> {
      return [{ result: undefined }];
    },
```

4. Extend the `ChromeStub` interface and the returned object:

```ts
  /** Every url passed to `chrome.tabs.create`, oldest first. */
  createdTabs(): string[];
```

```ts
    createdTabs: () => [...createdTabs],
```

5. Update `setTabs`'s declared parameter type in the interface to `Array<{ id?: number; url?: string; title?: string }>`.

- [ ] **Step 15: Write the failing popup tests**

Append to `tests/unit/extension/popup.test.ts`, inside the top-level `describe('initPopup', ...)`:

```ts
  // --- Reading mode (design addendum §7): the "Read this page" section ---

  describe('#reading', () => {
    /** Installs the stub with one active tab, optionally alongside other tabs the `?jd-tab=` hook
     * could name instead. */
    function withTabs(tabs: Array<{ id?: number; url?: string; title?: string }>): ChromeStub {
      const stub = installChromeStub();
      stub.setTabs(tabs);
      return stub;
    }

    /** Spies on the stub's executeScript, recording the injection and resolving `result` as Chrome's
     * InjectionResult would. The cast narrows chrome.scripting to the one method being mocked. */
    function spyOnExecuteScript(result: unknown) {
      const { scripting } = (globalThis as unknown as { chrome: { scripting: { executeScript(o: unknown): Promise<unknown> } } }).chrome;
      return vi.spyOn(scripting, 'executeScript').mockResolvedValue([{ result }]);
    }

    const stateSend = () => makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({ focus: 'why does it work' }) : { ok: true, type: 'setSettings' }));

    afterEach(() => {
      vi.restoreAllMocks();
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it('fills the focus box from settings and saves it 300ms after the last keystroke', async () => {
      vi.useFakeTimers();
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const doc = loadDoc();
      const calls: Request[] = [];
      const send = makeFakeSend((req) => {
        calls.push(req);
        return req.type === 'getState' ? getStateResponse({ focus: 'why does it work' }) : { ok: true, type: 'setSettings' };
      });
      await initPopup(doc, { send: asSend(send) });

      const focus = el<HTMLInputElement>(doc, 'focus');
      expect(focus.value).toBe('why does it work');

      focus.value = 'how is position represented';
      focus.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(299);
      expect(calls.filter((c) => c.type === 'setSettings')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const patches = calls.filter((c) => c.type === 'setSettings').map((c) => (c.type === 'setSettings' ? c.patch : undefined));
      expect(patches).toEqual([{ focus: 'how is position represented' }]);

      doc.dispatchEvent(new Event('unload'));
    });

    it('offers Read this page on an ordinary http(s) page', async () => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').hidden).toBe(false);
      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(false);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(true);
      expect(el(doc, 'read-status').textContent).toBe('');

      doc.dispatchEvent(new Event('unload'));
    });

    it.each(['https://example.test/paper.PDF', 'https://arxiv.org/pdf/1706.03762'])('offers Read this PDF for %s', async (url) => {
      withTabs([{ id: 7, url }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').hidden).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(false);

      doc.dispatchEvent(new Event('unload'));
    });

    it('disables Read this page on a chrome:// tab and says why', async () => {
      withTabs([{ id: 7, url: 'chrome://extensions/' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(true);
      expect(el(doc, 'read-status').textContent).toBe('not a web page');

      doc.dispatchEvent(new Event('unload'));
    });

    it('injects read-page.js into the active tab and reports the passage count', async () => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const spy = spyOnExecuteScript({ state: 'started', passages: 21 });
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(spy).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['read-page.js'] });
      expect(el(doc, 'read-status').textContent).toBe('reading 21 passages');

      doc.dispatchEvent(new Event('unload'));
    });

    it.each([
      [{ state: 'stopped' }, 'stopped'],
      [{ state: 'no-article', passages: 3 }, 'this page does not look like an article (3 passages)'],
      [undefined, 'reading'],
    ])('reports %j as %s', async (result, expected) => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      spyOnExecuteScript(result);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe(expected);
      doc.dispatchEvent(new Event('unload'));
    });

    it('reports a refused injection, and offers the PDF reader when the tab looks like a PDF', async () => {
      withTabs([{ id: 7, url: 'https://example.test/download', title: 'paper.pdf' }]);
      const { scripting } = (globalThis as unknown as { chrome: { scripting: { executeScript(o: unknown): Promise<unknown> } } }).chrome;
      vi.spyOn(scripting, 'executeScript').mockRejectedValue(new Error('Cannot access contents of the page'));
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe("can't read this tab: Cannot access contents of the page");
      expect(el(doc, 'read-status').classList.contains('error')).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(false);

      doc.dispatchEvent(new Event('unload'));
    });

    it('Read this PDF opens the reader page on the tab url, and the hint link opens it empty', async () => {
      const stub = withTabs([{ id: 7, url: 'https://example.test/paper.pdf' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-pdf').click();
      el<HTMLAnchorElement>(doc, 'open-reader').click();
      await flush();

      expect(stub.createdTabs()).toEqual([
        `${EXTENSION_ORIGIN}/reader.html?src=${encodeURIComponent('https://example.test/paper.pdf')}`,
        `${EXTENSION_ORIGIN}/reader.html`,
      ]);

      doc.dispatchEvent(new Event('unload'));
    });

    it('takes the tab id from tabs.query({url}) under the ?jd-tab= hook', async () => {
      withTabs([
        { id: 7, url: `${EXTENSION_ORIGIN}/popup.html?jd-tab=x` },
        { id: 42, url: 'https://example.test/article' },
      ]);
      const spy = spyOnExecuteScript({ state: 'started', passages: 21 });
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()), activeTabUrl: 'https://example.test/article' });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(spy).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['read-page.js'] });
      doc.dispatchEvent(new Event('unload'));
    });
  });
```

- [ ] **Step 16: Run them to watch them fail**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts`
Expected: FAIL — `popup: missing #focus` from the `$` helper, because the section is not in popup.html yet.

- [ ] **Step 17: Add the section to `src/extension/popup/popup.html`**

Insert this between the **What to hide / keep** section and the **Rules** section, verbatim from spec §7:

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

- [ ] **Step 18: Style it in `src/extension/popup/popup.css`**

Append, after the `.jd-sites a` rule:

```css
/* Read this page: the hint line under the buttons, and the link into the PDF reader. */
.jd-hint {
  color: var(--muted);
  margin: 6px 0 0;
}

.jd-hint a {
  color: var(--muted);
}
```

- [ ] **Step 19: Wire it up in `src/extension/popup/popup.ts`**

1. Add the type import next to the existing ones:

```ts
import type { ReadResult } from '../read-page';
```

2. Replace the `activeTab` helper (lines 34-42) with:

```ts
async function activeTab(hookUrl?: string): Promise<{ id?: number; url?: string; title?: string } | undefined> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return undefined;
  try {
    // `?jd-tab=<url>` is the e2e's popup-in-a-tab hook: `{active:true}` would answer with the popup's
    // OWN tab there, so the tab to act on is named by URL instead. It needs host permission for that
    // URL, which the e2e's patched manifest grants; nothing in the shipped UI ever sets the hook, and
    // a miss falls through to the normal query rather than leaving the popup with no tab at all.
    if (hookUrl !== undefined) {
      const [named] = await chrome.tabs.query({ url: hookUrl });
      if (named) return named;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}
```

3. Add the module-level helpers, after `parseHttpUrl`:

```ts
/** §7: a tab worth offering the PDF reader for — a `.pdf` path, or an arXiv `/pdf/<id>` URL, which
 * serves a PDF with no extension at all. */
function looksLikePdf(url: URL): boolean {
  return /\.pdf$/i.test(url.pathname) || (url.hostname === 'arxiv.org' && url.pathname.startsWith('/pdf/'));
}

/** §7's status line for the injection result. `undefined` means the script ran but handed nothing
 * back (an older build, or a frame that could not report) — it is still reading. */
function describeRead(result: ReadResult | undefined): string {
  if (!result) return 'reading';
  if (result.state === 'stopped') return 'stopped';
  if (result.state === 'no-article') return `this page does not look like an article (${result.passages} passages)`;
  return `reading ${result.passages} passages`;
}
```

4. Add the element lookups, next to the others inside `initPopup`:

```ts
  const focusEl = $<HTMLInputElement>(doc, 'focus');
  const readPageBtn = $<HTMLButtonElement>(doc, 'read-page');
  const readPdfBtn = $<HTMLButtonElement>(doc, 'read-pdf');
  const readStatusEl = $(doc, 'read-status');
  const openReaderEl = $<HTMLAnchorElement>(doc, 'open-reader');
```

5. Add `focusEl.value = s.focus;` to `fillSettings`, next to `intentEl.value = s.intent;`.

6. Add the reading state and its renderer, after the This-site block:

```ts
  // --- Read this page (design addendum §7): the reader is an action, never an always-on judge ---

  /** The active tab's http(s) URL and title, resolved once below. `undefined` is "not a web page". */
  let tabUrl: URL | undefined;
  let tabTitle: string | undefined;

  function setReadStatus(text: string, isError = false): void {
    readStatusEl.textContent = text;
    readStatusEl.classList.toggle('error', isError);
  }

  function renderReading(): void {
    if (!tabUrl) {
      readPageBtn.hidden = false;
      readPageBtn.disabled = true;
      readPdfBtn.hidden = true;
      setReadStatus('not a web page');
      return;
    }
    const pdf = looksLikePdf(tabUrl);
    readPageBtn.hidden = pdf;
    readPageBtn.disabled = false;
    readPdfBtn.hidden = !pdf;
    setReadStatus('');
  }

  /** Opens the extension's own reader page, optionally pointed at a PDF. Not web-accessible: only
   * the extension can navigate to it (§10). */
  function openReader(src?: string): void {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`reader.html${src ? `?src=${encodeURIComponent(src)}` : ''}`) });
  }
```

7. Add the handlers, next to the `siteToggleEl` listener:

```ts
  // activeTab covers this injection: opening the popup is the gesture that grants it, and the script
  // goes into the current tab and nowhere else (§11). The result is the injected bundle's completion
  // value — see scripts/build.mjs's footer.
  readPageBtn.addEventListener(
    'click',
    guardClick([readPageBtn], async () => {
      if (tabId === undefined) {
        setReadStatus("can't read this tab: no tab id", true);
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({ target: { tabId }, files: ['read-page.js'] });
        setReadStatus(describeRead(results[0]?.result as ReadResult | undefined));
      } catch (err) {
        setReadStatus(`can't read this tab: ${err instanceof Error ? err.message : String(err)}`, true);
        // A tab Chrome will not let a script into is very often a PDF it is displaying itself, which
        // the reader page CAN open — so offer it rather than leaving a dead end.
        if (tabTitle?.toLowerCase().endsWith('.pdf')) readPdfBtn.hidden = false;
      }
    }),
  );

  readPdfBtn.addEventListener('click', () => openReader(tabUrl?.href));
  openReaderEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    openReader();
  });

  const debouncedFocus = debounce((v: string) => patchSettings({ focus: v }), DEBOUNCE_MS);
  focusEl.addEventListener('input', () => debouncedFocus(focusEl.value));
```

8. Extend the tab resolution near the end of `initPopup` (lines 390-394):

```ts
  const tab = await activeTab(deps.activeTabUrl);
  tabId = tab?.id;
  tabTitle = tab?.title;
  const parsedUrl = parseHttpUrl(deps.activeTabUrl ?? tab?.url ?? '');
  tabUrl = parsedUrl;
  siteOrigin = parsedUrl?.origin;
  siteBuiltIn = parsedUrl !== undefined && isBuiltInHost(parsedUrl.hostname);
  renderReading();
```

- [ ] **Step 20: Run the popup tests to verify they pass**

Run: `pnpm vitest run tests/unit/extension/popup.test.ts`
Expected: PASS — the ten new cases plus every existing one. (`EXTENSION_ORIGIN` is already imported by that file.)

- [ ] **Step 21: Write the e2e `tests/e2e/reading.spec.ts`**

A context of its own, so nothing here depends on `extension.spec.ts`'s serial provider switching.

```ts
// End-to-end reading mode: the REAL built extension reading the article fixture, driven from the
// popup exactly as a user would. Its own browser context (Playwright runs spec files one at a time
// here), because extension.spec.ts switches the provider to a live key partway through its run.

import { expect, test } from '@playwright/test';
import { fnv1a } from '../../src/core/hash';
import { launchWithExtension, seedSettings, type LaunchedExtension } from './helpers';
import { FIXTURE_ORIGIN } from './server';

const ARTICLE_URL = `${FIXTURE_ORIGIN}/article.html`;

// The reader derives `rd:<fnv1a(text.slice(0,300))>` from the paragraph's collapsed text, and every
// paragraph in the fixture is a single literal line — so these ids are computable here, by hand, the
// same way the generic e2e derives its own.
const id = (text: string): string => `rd:${fnv1a(text.slice(0, 300))}`;

const ABSTRACT =
  'We study how attention layers behave on documents far longer than the window they were trained on, and show that a fixed sinusoidal encoding degrades more gracefully than a learned one.';
const METHOD =
  'The method encodes each input token as a vector, adds a positional signal to it, and then applies a stack of attention layers in which every position attends to every other position of the same sequence.';
const ACK =
  'We thank our colleagues for their comments on an earlier draft, the reviewers for their careful reading, and the maintainers of the open source libraries this work depends on.';
const BOILER =
  'This work was supported by internal funding. The authors declare no competing interests. Correspondence should be addressed to the first author.';

const MOCK_FIXTURES: Record<string, Record<string, number>> = {
  [id(ABSTRACT)]: { core: 0.95 },
  [id(METHOD)]: { core: 0.95 },
  [id(ACK)]: { core: 0.05 },
  [id(BOILER)]: { core: 0.05 },
};

test.describe.configure({ mode: 'serial' });

let ext: LaunchedExtension;

test.beforeAll(async () => {
  ext = await launchWithExtension();
  await seedSettings(ext, { providerMode: 'mock', mockFixtures: MOCK_FIXTURES, focus: '' });
});

test.afterAll(async () => {
  await ext?.close();
});

test('Read this page highlights, dims, lists and then stops', async () => {
  // The article tab has to exist before the popup opens: the `?jd-tab=` hook finds it by URL.
  const article = await ext.context.newPage();
  await article.goto(ARTICLE_URL);

  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?jd-tab=${encodeURIComponent(ARTICLE_URL)}`);

  await popup.locator('#read-page').click();
  await expect(popup.locator('#read-status')).toHaveText('reading 21 passages');

  // The two pinned highlights and the two pinned dims; everything else is whatever the mock's
  // text-overlap heuristic made of it, which is why the counts below are relative, not absolute.
  await expect(article.locator('#p-abstract')).toHaveClass(/jd-hl/);
  await expect(article.locator('#p-method-1')).toHaveClass(/jd-hl/);
  await expect(article.locator('#p-ack')).toHaveClass(/jd-dim/);
  await expect(article.locator('#p-boiler')).toHaveClass(/jd-dim/);
  await expect(article.locator('#p-abstract .jd-rtag')).toHaveText(/95%$/);

  // Playwright's CSS engine pierces the panel's open shadow root, so the list is addressable here.
  const highlights = await article.locator('.jd-hl').count();
  expect(highlights).toBeGreaterThanOrEqual(2);
  await expect(article.locator('#jd-reader ol li')).toHaveCount(highlights);
  await expect(article.locator('#jd-reader .progress')).toHaveText(/^21 passages · /);

  await article.getByRole('button', { name: 'Show all' }).click();
  await expect(article.locator('.jd-dim')).toHaveCount(0);

  // Reading is a toggle: the same injection stops it and puts the page back exactly as it was.
  await popup.locator('#read-page').click();
  await expect(popup.locator('#read-status')).toHaveText('stopped');
  await expect(article.locator('.jd-hl')).toHaveCount(0);
  await expect(article.locator('.jd-rtag')).toHaveCount(0);
  await expect(article.locator('#jd-reader')).toHaveCount(0);

  await popup.close();
  await article.close();
});

test('a page that is not an article is left alone, and the popup says so', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/generic.html`); // a timeline of short statuses, not a document

  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?jd-tab=${encodeURIComponent(`${FIXTURE_ORIGIN}/generic.html`)}`);

  await popup.locator('#read-page').click();
  await expect(popup.locator('#read-status')).toHaveText(/^this page does not look like an article \(\d+ passages\)$/);
  await expect(page.locator('#jd-reader')).toHaveCount(0);
  await expect(page.locator('.jd-hl, .jd-dim')).toHaveCount(0);

  await popup.close();
  await page.close();
});
```

- [ ] **Step 22: Run the reading e2e**

Run: `pnpm build && pnpm test:e2e reading.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 23: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 24: Commit**

```bash
git add src/extension/messages.ts src/extension/background.ts src/extension/read-page.ts \
        src/extension/reading/reader-ui.ts src/extension/reading/run.ts \
        src/extension/popup/popup.html src/extension/popup/popup.ts src/extension/popup/popup.css \
        scripts/build.mjs tests/unit/extension/chrome-stub.ts tests/unit/extension/reader-ui.test.ts \
        tests/unit/extension/background.test.ts tests/unit/extension/popup.test.ts tests/e2e/reading.spec.ts
git commit -m "$(cat <<'EOF'
feat(extension): read this page — popup, background and the in-page reader

One click injects the reader under activeTab, a second click takes it away.
The background gains one ungated readPassages handler over a ReadingJudge it
replaces whenever the provider or a key changes; the panel lives in a shadow
root and dims without ever hiding. The injected bundle hands its result back
to the popup as its completion value, appended by esbuild's footer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The PDF reader page, the build wiring and the docs

**Files:**
- Create: `src/extension/reader/reader.html`, `src/extension/reader/reader.ts`, `src/extension/reader/reader.css`
- Modify: `scripts/build.mjs` (the `reader.js` entry, the html/css copies, the pdf.js worker copy), `tests/e2e/server.ts` (serve `.pdf` as `application/pdf`), `tests/e2e/reading.spec.ts` (the sample.pdf test), `README.md` (a new **Reading mode** section, a line in **Using it**, the non-goals under **Status & known limits**), `CONTRIBUTING.md` (the fixture rule covers the reading fixtures)
- Test: the new e2e case; the reader page itself is covered end-to-end rather than in jsdom, because every interesting part of it is `fetch`, `chrome.permissions` and real pdf.js

**Interfaces:**
- Consumes: `loadPages(data, pdfjs)`, `PdfjsLike` (Task 3); `pagesToBlocks(pages, fallbackTitle)`, `PdfDoc` (Task 3); `mountReader`, `ReaderHandle` (Task 4); `runReading` (Task 4); `ArticlePassage` (Task 2, `import type` only); `passageId`, `TITLE_MAX`, `LEAD_MAX`, `DocContext` (Task 1); `send` and `Settings.focus` (Task 4).
- Produces: `dist/extension/reader.html`, `reader.js`, `reader.css` and `pdf.worker.mjs`; the page is reached only through `chrome.runtime.getURL('reader.html')` and is not web-accessible.

- [ ] **Step 1: Serve PDFs from the fixture server**

In `tests/e2e/server.ts`, add to the `TYPES` map:

```ts
  '.pdf': 'application/pdf',
```

- [ ] **Step 2: Add the reader to `scripts/build.mjs`**

1. Add the entry to `extEntries`, after the `read-page.ts` entry:

```js
  // The reader page is an ordinary extension page, so its bundle may stay ESM — which matters,
  // because it carries pdf.js.
  { entry: path.join('reader', 'reader.ts'), out: 'reader.js', format: 'esm' },
```

2. Add the two static files to the copy list (the `for (const file of [...])` loop):

```js
for (const file of [
  'manifest.json',
  path.join('popup', 'popup.html'),
  path.join('popup', 'popup.css'),
  path.join('reader', 'reader.html'),
  path.join('reader', 'reader.css'),
  'styles.css',
]) {
```

3. Add the worker copy immediately after that loop:

```js
// pdf.js runs its parser in a worker, which must be a file of its own: it is loaded from the
// extension's own origin (reader.ts points GlobalWorkerOptions.workerSrc at chrome.runtime.getURL),
// which the default extension CSP allows and which needs no web_accessible_resources entry.
const workerSrc = path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const workerDest = path.join(extDist, 'pdf.worker.mjs');
await cp(workerSrc, workerDest);
outputs.push(rel(workerDest));
```

- [ ] **Step 3: Write `src/extension/reader/reader.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>jev-duo reader</title>
    <link rel="stylesheet" href="reader.css" />
  </head>
  <body>
    <header class="jd-head">
      <p id="source" class="jd-source"></p>
      <p id="arxiv-hint" class="jd-hint" hidden></p>
      <div class="jd-row">
        <input type="text" id="focus" placeholder="What are you looking for? (optional)" />
        <button id="read" type="button">Read</button>
      </div>
      <div class="jd-row">
        <span id="status" class="jd-status"></span>
        <button id="allow" type="button" hidden></button>
      </div>
      <div class="jd-row">
        <label for="file">Open a PDF from your computer</label>
        <input type="file" id="file" accept="application/pdf" />
      </div>
    </header>
    <main id="doc"></main>
    <script type="module" src="reader.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `src/extension/reader/reader.css`**

```css
/*
 * The PDF reader page. One readable column of extracted text — this is not a PDF viewer and never
 * renders a page image: the point is passages the reader can judge, highlight and dim. The
 * highlight/dim classes themselves come from reading/reader-ui.ts's READER_CSS at runtime.
 */

:root {
  --bg: #ffffff;
  --fg: #35353c;
  --muted: #6b6b73;
  --border: #dcdce2;
  --field-bg: #f0f0f3;
  --error: #b3261e;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c20;
    --fg: #d6d6dc;
    --muted: #a4a4ac;
    --border: #3a3a41;
    --field-bg: #26262b;
    --error: #ff6b6b;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0 0 80px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  background: var(--bg);
  color: var(--fg);
}

.jd-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 10px 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.jd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.jd-source {
  margin: 0;
  color: var(--muted);
  word-break: break-all;
}

.jd-hint,
.jd-status {
  margin: 4px 0 0;
  color: var(--muted);
}

.jd-status.error {
  color: var(--error);
}

input[type="text"] {
  flex: 1;
  max-width: 420px;
}

input[type="text"],
button {
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--field-bg);
  color: var(--fg);
}

button {
  cursor: pointer;
}

main {
  max-width: 720px;
  margin: 0 auto;
  padding: 16px;
}

h1 {
  font-size: 22px;
  line-height: 1.3;
}

.jd-heading {
  font-size: 16px;
  margin: 24px 0 8px;
}

.jd-passage {
  margin: 0 0 14px;
}

.jd-page-mark {
  margin: 28px 0 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
}
```

- [ ] **Step 5: Write `src/extension/reader/reader.ts`**

```ts
// The PDF reader page (design addendum §6.3). It exists because an injected content script cannot do
// two things this page can: fetch a cross-origin PDF with a host permission, and ask for that
// permission from a click. Everything after "bytes -> passages" is the same code the injected reader
// runs — reading/reader-ui.ts for the panel, reading/run.ts for the judging — so both readers behave
// identically once there is something to read.
//
// The PDF bytes never leave the browser (§11): only the extracted passages, the title and the lead
// are ever sent, to the same provider the rest of the extension uses.

import * as pdfjsLib from 'pdfjs-dist';
import { LEAD_MAX, TITLE_MAX, passageId, type DocContext } from '../../core/reading';
import { send } from '../messages';
import type { ArticlePassage } from '../reading/article';
import { loadPages, type PdfjsLike } from '../reading/pdf-load';
import { pagesToBlocks, type PdfDoc } from '../reading/pdf-text';
import { mountReader, type ReaderHandle } from '../reading/reader-ui';
import { runReading } from '../reading/run';

// pdf.js's own types are far more specific than loadPages needs; one cast at the boundary keeps a
// pdfjs-dist patch release from being able to break `pnpm typecheck`.
const pdfjs = pdfjsLib as unknown as PdfjsLike;
// Loaded from the extension's own origin, which the default extension CSP allows.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`reader: missing #${id}`);
  return found as T;
}

const sourceEl = $('source');
const hintEl = $('arxiv-hint');
const focusEl = $<HTMLInputElement>('focus');
const readBtn = $<HTMLButtonElement>('read');
const statusEl = $('status');
const allowBtn = $<HTMLButtonElement>('allow');
const fileEl = $<HTMLInputElement>('file');
const docEl = $('doc');

const src = new URLSearchParams(location.search).get('src') ?? undefined;

let bytes: ArrayBuffer | undefined;
let sourceName = src ?? '';
let handle: ReaderHandle | undefined;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

const fileNameOf = (name: string): string => name.split(/[/\\]/).pop() || name;

/** arXiv's `/pdf/<id>` has an HTML twin at `/html/<id>` that keeps real paragraphs; a PDF only has
 * glyph positions. `<id>` is the rest of the path exactly as given, minus a trailing `.pdf`. */
function arxivHtmlUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.host !== 'arxiv.org' || !url.pathname.startsWith('/pdf/')) return undefined;
  const id = url.pathname.slice('/pdf/'.length).replace(/\.pdf$/i, '');
  return id === '' ? undefined : `https://arxiv.org/html/${id}`;
}

function renderHint(): void {
  const html = src === undefined ? undefined : arxivHtmlUrl(src);
  if (!html) {
    hintEl.hidden = true;
    return;
  }
  hintEl.hidden = false;
  hintEl.textContent = 'arXiv also publishes an HTML version of most papers: ';
  const link = document.createElement('a');
  link.href = html;
  link.textContent = 'open it';
  hintEl.append(link, ', then click Read this page — HTML gives better paragraphs than a PDF.');
}

/** §6.3's permission fallback. `chrome.permissions.request` needs a user gesture, so it can only ever
 * be called from this click handler — never from the load path that discovered the problem. */
function offerPermission(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    setStatus(`can't fetch this file from ${url}`, true);
    return;
  }
  setStatus(`can't fetch this file from ${origin}`, true);
  allowBtn.hidden = false;
  allowBtn.textContent = `Allow access to ${origin}`;
  allowBtn.onclick = (): void => {
    void (async () => {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      if (!granted) {
        setStatus('permission declined', true);
        return;
      }
      allowBtn.hidden = true;
      await load(url);
    })();
  };
}

/** arXiv serves `access-control-allow-origin: *`, so its PDFs load with no permission at all; a host
 * that does not is where the button above comes in. */
async function fetchPdf(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch {
    offerPermission(url);
    return undefined;
  }
}

function render(doc: PdfDoc): ArticlePassage[] {
  docEl.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = doc.title;
  docEl.appendChild(h1);

  const passages: ArticlePassage[] = [];
  let lastPage = 0;
  for (const block of doc.blocks) {
    if (block.page !== lastPage) {
      lastPage = block.page;
      const mark = document.createElement('div');
      mark.className = 'jd-page-mark';
      mark.textContent = `p. ${block.page}`;
      docEl.appendChild(mark);
    }
    if (block.kind === 'heading') {
      const h2 = document.createElement('h2');
      h2.className = 'jd-heading';
      h2.textContent = block.text;
      docEl.appendChild(h2);
      continue;
    }
    const p = document.createElement('p');
    p.className = 'jd-passage';
    p.dataset.index = String(passages.length);
    p.dataset.page = String(block.page);
    p.textContent = block.text;
    docEl.appendChild(p);
    passages.push({ id: passageId(block.text), index: passages.length, text: block.text, page: block.page, el: p });
  }
  return passages;
}

async function read(): Promise<void> {
  if (!bytes) return;
  handle?.destroy();
  handle = undefined;
  setStatus('reading…');

  // A COPY: pdf.js transfers the typed array it is given to its worker, which detaches the buffer —
  // and the Read button re-reads the same document with a new focus.
  const { pages, metaTitle } = await loadPages(bytes.slice(0), pdfjs);
  const doc = pagesToBlocks(pages, metaTitle ?? fileNameOf(sourceName));
  const passages = render(doc);
  if (passages.length === 0) {
    setStatus('no text found in this PDF (scanned pages need OCR, which jev-duo does not do)', true);
    return;
  }

  const ctx: DocContext = { title: doc.title.slice(0, TITLE_MAX), lead: passages[0].text.slice(0, LEAD_MAX), source: sourceName };
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
  bytes = data;
  sourceName = url;
  await read();
}

fileEl.addEventListener('change', () => {
  const file = fileEl.files?.[0];
  if (!file) return;
  void (async () => {
    // A picked file never touches the network at all, which is also the answer for file:// URLs
    // (§13): the picker is how you read one.
    bytes = await file.arrayBuffer();
    sourceName = file.name;
    sourceEl.textContent = file.name;
    allowBtn.hidden = true;
    await read();
  })();
});

readBtn.addEventListener('click', () => {
  void (async () => {
    readBtn.disabled = true;
    try {
      // Saved to settings, so the popup and this page always ask the same question.
      await send({ type: 'setSettings', patch: { focus: focusEl.value } });
      await read();
    } finally {
      readBtn.disabled = false;
    }
  })();
});

async function init(): Promise<void> {
  sourceEl.textContent = src ?? '';
  renderHint();
  // An extension page may ask for getState; a content script may not, which is why the injected
  // reader has to wait for the focus and this one does not.
  const state = await send({ type: 'getState' });
  if (state.ok && state.type === 'getState') focusEl.value = state.settings.focus;
  if (src === undefined) {
    setStatus('open a PDF from your computer to read it');
    return;
  }
  await load(src);
}

void init().catch((err: unknown) => console.error('jev-duo reader: init failed', err));
```

- [ ] **Step 6: Build and check the output**

Run: `pnpm build && ls dist/extension`
Expected: `reader.html`, `reader.js`, `reader.css` and `pdf.worker.mjs` are listed alongside the existing files.
Run: `node -e "const s=require('fs').statSync('dist/extension/pdf.worker.mjs'); console.log(s.size > 100000)"`
Expected: `true` (the real worker, not an empty copy).

- [ ] **Step 7: Add the sample.pdf e2e**

Append to `tests/e2e/reading.spec.ts`:

```ts
test('the reader page reads a PDF fetched from a host the manifest allows', async () => {
  // The e2e's patched manifest declares the fixture origin as a host permission, which is what the
  // reader page's "Allow access" button would otherwise have to ask for.
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent(`${FIXTURE_ORIGIN}/sample.pdf`)}`);

  // Exactly what make-sample-pdf.mjs draws: four paragraphs per page, one page mark per page, and
  // four headings (the title block plus the three numbered ones).
  await expect(page.locator('.jd-passage')).toHaveCount(8);
  await expect(page.locator('.jd-page-mark')).toHaveCount(2);
  await expect(page.locator('.jd-heading')).toHaveCount(4);
  await expect(page.locator('h1')).toHaveText('Sample Paper');

  // The method paragraph is the one MOCK_FIXTURES pins to core 0.95 — the same text the generator
  // draws across three lines on page two, rejoined by the extractor.
  await expect(page.locator('.jd-passage', { hasText: 'every position attends to every other position' })).toHaveClass(/jd-hl/);
  await expect(page.locator('#jd-reader ol li')).not.toHaveCount(0);
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);

  await page.close();
});
```

- [ ] **Step 8: Run the reading e2e**

Run: `pnpm build && pnpm test:e2e reading.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Document it in `README.md`**

1. Add a step 7 to **Using it**, after the current step 6:

```markdown
7. Read one document. The popup's **Read this page** button highlights what carries the substance on
   a long-form page and dims the filler; on a PDF it opens jev-duo's own reader. See
   [Reading mode](#reading-mode).
```

2. Add this section between **Other sites** and **CLI**:

```markdown
## Reading mode

Feed mode filters a stream. Reading mode reads *one document* with you: it highlights the passages
that carry the substance — or that answer a question you type — dims the filler, and gives you a
clickable outline of the highlights. Same fast brain, one call per passage, no slow brain at all, so
a TypeSafe-only setup works.

**On a web page.** Open a long-form page, click the jev-duo icon, and press **Read this page**. The
optional box above it is your question: `how does the caching work` makes "does this answer the
reader's question?" the thing that decides, instead of "is this substantive?". Highlighted passages
get a left rule and a tag reading `<kind> · <confidence>`; filler drops to 35 % opacity and comes
back when you hover it. Nothing is ever hidden. The panel in the bottom-right lists every highlight
in document order — click one to scroll to it — and has **Show all** (bring the dimmed passages back)
and **Close**. Pressing **Read this page** a second time puts the page back exactly as it was.

If the page is not a document — a feed, an app shell, a docs page of four short paragraphs — the
popup says `this page does not look like an article (N passages)` and nothing is touched. Reading
needs at least 6 paragraphs and 1500 characters inside one container to call something an article.

**On a PDF.** The popup swaps in **Read this PDF** when the tab looks like one (a `.pdf` path, or an
arXiv `/pdf/` URL); **Open the PDF reader** in the hint line opens the same page empty. The reader
fetches the PDF, extracts its text — paragraphs rejoined across line breaks, running headers and page
numbers dropped, two-column pages read in the right order — and reads it exactly as it reads a page,
with a `p. N` mark before each page's first block. A host that does not send permissive CORS headers
needs its own permission: the reader says `can't fetch this file from <origin>` and offers **Allow
access to <origin>**, which asks Chrome for that one origin. **Open a PDF from your computer** reads a
local file instead, which never touches the network at all. For an arXiv PDF the reader points at the
HTML version of the same paper, which has real paragraphs and reads better.

**What is sent.** Per passage: the passage text (capped at 1500 characters), the document title and
its lead (capped at 600). Nothing else — no URL, no page, no surrounding text — and no LLM call is
made at any point. PDF bytes are fetched by the reader page and never leave the browser. Reading a
page injects the reader into that one tab under `activeTab`; no new permission is added to the
manifest for any of this.

**Limits.** Reading is explicit, per document, and never runs on its own. Judgments use fixed
thresholds — the **Strictness** slider is a feed-mode control and does not apply. A passage whose
judgment fails or times out is shown plain rather than dimmed. Documents are capped at 600 passages.
```

3. Add to **Status & known limits**, after the generic-adapter bullet:

```markdown
- **Reading mode does not do everything.** No scanned PDFs (a page with no text layer needs OCR,
  which jev-duo does not do — the reader says so rather than showing an empty document), no `file://`
  URLs (use **Open a PDF from your computer**), no reading on page load, no figures, math or tables
  (a table is flattened into one run of text before it is judged, when it is not excluded outright),
  no comment filtering, no DOCX or EPUB, and no Firefox. The strictness slider does not apply to
  reading: it uses fixed thresholds.
```

- [ ] **Step 10: Extend the fixture rule in `CONTRIBUTING.md`**

Append to the **Adapters and fixtures** section:

```markdown
Reading mode has two fixtures of its own. `tests/e2e/fixtures/article.html` is an arXiv-like paper
with exactly 21 qualifying passages, and every shape that must *not* become one around them (a nav
blurb, a figure, three hidden paragraphs, a bibliography of `li`, a footer); change the extraction
rules in `src/extension/reading/article.ts` and that fixture moves with them, because the passage
count is what proves the rules still recognise a document. `tests/e2e/fixtures/sample.pdf` is
committed and written by `pnpm fixtures:pdf` (`tests/e2e/fixtures/make-sample-pdf.mjs`), which is
deterministic — regenerate it rather than editing the bytes, and commit the result.
```

- [ ] **Step 11: Run the full gate and package the extension**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e && pnpm package:ext`
Expected: all green; `package:ext` reports a zip that is noticeably larger than before (pdf.js and its worker).
Run: `LIVE=1 pnpm test:e2e` once with a key in `.env`
Expected: the `@live-jev` reading test passes and prints its token count.

- [ ] **Step 12: Commit**

```bash
git add src/extension/reader scripts/build.mjs tests/e2e/server.ts tests/e2e/reading.spec.ts README.md CONTRIBUTING.md
git commit -m "$(cat <<'EOF'
feat(extension): PDF reader page and reading-mode docs

An extension page that fetches a PDF (asking for the origin only when CORS
says no), extracts its text with pdf.js, and runs the same reader flow an
HTML page gets, page marks and all. A picked file never touches the network.
README gains a Reading mode section and the spec's non-goals.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

### 1. Spec coverage

| Spec section | Where it lands |
| --- | --- |
| §1 Goal | The whole plan; the shape (one document, one call per passage, no slow brain) is fixed by Task 1's question template and Task 4's `runReading`. |
| §2 Principles — explicit per page | Task 4: the popup button, the toggle in `read-page.ts`, no manifest change. |
| §2 — never hide | Task 4: `READER_CSS`'s `jd-dim` at `.35` with a `:hover` restore, **Show all** / **Dim again**, and the reader-ui tests for both. |
| §2 — no slow brain | Task 1: `readingQuestions` is a fixed template; no compiler, arbiter or LLM anywhere in the plan. |
| §2 — fail open | Task 1 (`ReadingJudge`'s catch, its two tests), Task 4 (`runReading`'s failed-batch branch and its test). |
| §2 — one pipeline, two sources | Tasks 2 and 3 both produce `Passage[]`; Tasks 4 and 5 share `reader-ui.ts` and `run.ts`. |
| §3 Passages (types, constants, id, 600 cap) | Task 1 Step 3; caps exercised in Task 2 Step 2 (HTML) and Task 3 Step 2 (PDF). |
| §4.1 Questions and state | Task 1 Steps 1 and 3. |
| §4.2 Decision and thresholds | Task 1 Steps 1 and 3 — with Decision (1) on the one contradictory row. |
| §4.3 Judge (concurrency, cache, timeout, order, usage) | Task 1 Steps 5 and 8. |
| §5 HTML articles | Task 2 Steps 4, 5 and 7; every numbered rule has a test in Step 2. |
| §6.1 PDF text geometry | Task 3 Steps 2 and 4 — with Decision (2) on the running-header threshold. |
| §6.2 Loading | Task 3 Steps 8 and 10, checked against the real legacy build. |
| §6.3 Reader page | Task 5 Steps 3, 4, 5 and 7. |
| §7 Popup | Task 4 Steps 15, 17, 18 and 19 (exact markup and every copy string). |
| §8.1 `read-page.ts` and the completion value | Task 4 Steps 12 and 13. |
| §8.2 `reader-ui.ts` | Task 4 Steps 7 and 9 — plus Decision (6)'s `setFocus`. |
| §9 Background | Task 4 Steps 1, 3 and 4; the judge's lifetime has two tests of its own. |
| §10 Build and manifest | Task 4 Step 13 (`read-page.js` + footer), Task 5 Step 2 (`reader.js`, the copies, the worker); `manifest.json` is never touched, which Task 5 Step 11's `package:ext` run confirms. |
| §11 Privacy | Enforced by `readingState` (Task 1) and the reader page's local-only bytes (Task 5); documented in Task 5 Step 9. |
| §12 Tests — unit | `reading.test.ts`, `reading-judge.test.ts` (Task 1), `article.test.ts` (Task 2), `pdf-text.test.ts`, `pdf-load.test.ts` (Task 3), `reader-ui.test.ts` plus the popup and background cases (Task 4). |
| §12 Tests — e2e | `reading.spec.ts`: the `article.html` run (Task 4 Step 21) and the `sample.pdf` run (Task 5 Step 7). |
| §12 Tests — `@live-jev` | Task 1 Step 10 — with Decision (12) on the `LIVE=1` guard. |
| §13 Non-goals | Task 5 Step 9's README bullet; the fixed thresholds are enforced by `decideReading` never reading `Settings.strictness`. |

No spec section is unassigned.

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to Task`, `etc.` in a code position, and `...` standing in for code. None present. Every code step carries the actual TypeScript, HTML, CSS, JavaScript or test code, including the full PDF generator and the full article fixture; every file the plan modifies is identified by path and, where the change is surgical, by line range or by the exact surrounding text. The two places that quote existing code (`dom-text.ts`'s moved helpers, `build.mjs`'s replaced loop) reproduce it in full rather than saying "as before".

### 3. Type consistency

- `Passage`, `DocContext`, `ReadingVerdict`, `ReadingVerdictKind` are defined once (Task 1) and imported under those names by `messages.ts`, `article.ts`, `pdf-text.ts`'s consumers, `reader-ui.ts`, `run.ts` and `reader.ts`.
- `ArticlePassage extends Passage { el: Element }` is defined once (Task 2) and consumed by `reader-ui.ts`'s `mountReader` and by `reader.ts`'s `render`, both of which build `{ id, index, text, page?, el }` — matching field for field. `runReading` takes plain `Passage[]` and strips `el` when it builds each batch, so no DOM node can reach a message.
- `ReadingJudge.judge(ctx, focus, passages, onVerdict?)` returns `{ verdicts, usageTokens, errors, ms }` in Task 1; `handleReadPassages` (Task 4) destructures exactly `verdicts`, `usageTokens`, `errors` and drops `ms`, and the `readPassages` response declares those three plus `focus`. `runReading` reads exactly those four fields off the response.
- `ReaderHandle`'s five members (`apply`, `setFocus`, `setProgress`, `finish`, `destroy`) are declared in Task 4 Step 9 and used with those names by `run.ts`, `read-page.ts` and `reader.ts`; `finish` takes `{ ms, usageTokens, errors }` in the declaration, in `run.ts`'s call and in the reader-ui tests.
- `ReadResult`'s three states (`started`, `stopped`, `no-article`) are declared in `read-page.ts` and narrowed by the popup's `describeRead` with the same names and the same `passages` field.
- `PageText`/`TextItem` are declared in `pdf-text.ts` and produced by `pdf-load.ts` with every field populated (`str`, `x`, `y`, `size`, `width`, `rotated`; `page`, `width`, `height`, `items`).
- `Settings.focus` is added once (Task 4 Step 3) and read by the background handler, the popup (`fillSettings`, the debounce) and the reader page (`init`, the Read button) — always as `focus`, never `readingFocus` or `question`.
- CSS class names are used identically in `READER_CSS`, `reader-ui.ts`, `reader.css`, `reader.ts` and both e2e specs: `jd-hl`, `jd-dim`, `jd-flash`, `jd-rtag`, `jd-passage`, `jd-heading`, `jd-page-mark`, and the ids `jd-reader` and `jd-reader-style`.
