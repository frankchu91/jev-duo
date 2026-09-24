// End-to-end reading mode: the REAL built extension reading the article fixture, driven from the
// popup exactly as a user would. Its own browser context (Playwright runs spec files one at a time
// here), because extension.spec.ts switches the provider to a live key partway through its run.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fnv1a } from '../../src/core/hash';
import { launchWithExtension, ROOT, seedSettings, type LaunchedExtension } from './helpers';
import { FIXTURE_ORIGIN } from './server';

const SAMPLE_PDF = path.join(ROOT, 'tests/e2e/fixtures/sample.pdf');

const ARTICLE_URL = `${FIXTURE_ORIGIN}/article.html`;

// The reader derives `rd:<fnv1a(text.slice(0,300))>` from the paragraph's collapsed text, and every
// paragraph in the fixture is a single literal line — so these ids are computable here, by hand, the
// same way the generic e2e derives its own.
const id = (text: string): string => `rd:${fnv1a(text.slice(0, 300))}`;

const ABSTRACT =
  'We study how attention layers behave on documents far longer than the window they were trained on, and show that a fixed sinusoidal encoding degrades more gracefully than a learned one.';
const METHOD =
  'The method encodes each input token as a vector, adds a positional signal to it, and then applies a stack of attention layers in which every position attends to every other position of the same sequence.';
const POSITIONAL =
  'Positional information is represented by fixed sinusoidal functions of the position index, one frequency per embedding dimension.';
const CLAIM =
  'We take the opposite approach and keep the whole document, paying for it with a cheaper comparison between positions that are far apart.';
const RESULT =
  'Past that length the baseline falls away quickly, while our model loses less than two points of accuracy out to sixty four thousand tokens.';
const ABLATION =
  'Ablating the sinusoidal encoding in favour of a learned one costs four points at the longest length and nothing at all at the shortest.';
const ACK =
  'We thank our colleagues for their comments on an earlier draft, the reviewers for their careful reading, and the maintainers of the open source libraries this work depends on.';
const BOILER =
  'This work was supported by internal funding. The authors declare no competing interests. Correspondence should be addressed to the first author.';
const HOUSEKEEPING =
  'Everything reported here was measured on public documents, and the extraction code used to produce the passages is released with the paper.';
const NO_OVERLAP =
  'No part of the training data overlaps with the evaluation documents, which were collected after the training snapshot was frozen.';

// Addendum 2026-09-23 §2: highlights are the top share of a document, ranked on `key`, so the fixtures
// seed `key` alongside `core` — six passages the ranking must pick and four it must dim, both sets
// pinned so neither count nor membership depends on the mock's own heuristic.
//
// The mock answers a question it has no fixture for from token overlap: `p = 0.08 + 1.6 × overlap ± 0.03`,
// so an unfixtured answer is never below 0.05. The six `key` values below are therefore the only ones
// over the 0.5 highlight floor, and the four `core` values below are the only ones under 0.05 — which
// is what makes "exactly these six, exactly these four" a stable assertion rather than a lucky one.
const MOCK_FIXTURES: Record<string, Record<string, number>> = {
  [id(ABSTRACT)]: { core: 0.95, key: 0.95 },
  [id(METHOD)]: { core: 0.95, key: 0.94 },
  [id(RESULT)]: { core: 0.9, key: 0.93 },
  [id(POSITIONAL)]: { core: 0.9, key: 0.92 },
  [id(ABLATION)]: { core: 0.9, key: 0.91 },
  [id(CLAIM)]: { core: 0.9, key: 0.9 },
  [id(ACK)]: { core: 0.01, key: 0.03 },
  [id(BOILER)]: { core: 0.02, key: 0.03 },
  [id(HOUSEKEEPING)]: { core: 0.03, key: 0.04 },
  [id(NO_OVERLAP)]: { core: 0.04, key: 0.04 },
};

/** Math.ceil(21 × HIGHLIGHT_SHARE) over the article fixture's 21 passages. */
const EXPECTED_HIGHLIGHTS = ['#p-abstract', '#p-intro-3', '#p-method-1', '#p-method-2', '#p-results-2', '#p-results-4'];
/** Math.floor(21 × DIM_SHARE), in ascending `core` order: the four lowest, all pinned above. */
const EXPECTED_DIMS = ['#p-ack', '#p-boiler', '#p-intro-5', '#p-method-5'];

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

  // The panel only settles once the whole document has been ranked (§2.3: nothing is decorated before
  // the last batch is in), so the summary line is waited on first and every count below reads a
  // finished run rather than a mid-flight snapshot.
  await expect(article.locator('#jd-reader .progress')).toHaveText(/^21 passages · /);

  // Exactly the top share of the document by `key`, and exactly the least substantive fifth by `core`:
  // both sets pinned by the fixtures above, so these are identities and not bounds. The tag carries the
  // probability the passage was RANKED on, which is now `key`.
  await expect(article.locator('.jd-hl')).toHaveCount(EXPECTED_HIGHLIGHTS.length);
  for (const pinned of EXPECTED_HIGHLIGHTS) await expect(article.locator(pinned)).toHaveClass(/jd-hl/);
  await expect(article.locator('.jd-dim')).toHaveCount(EXPECTED_DIMS.length);
  for (const pinned of EXPECTED_DIMS) await expect(article.locator(pinned)).toHaveClass(/jd-dim/);
  await expect(article.locator('#p-abstract .jd-rtag')).toHaveText(/95%$/);

  // Playwright's CSS engine pierces the panel's open shadow root, so the list is addressable here.
  await expect(article.locator('#jd-reader ol li')).toHaveCount(EXPECTED_HIGHLIGHTS.length);

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

test('the reader page renders a PDF in place and draws the highlights on it', async () => {
  // The e2e's patched manifest declares the fixture origin as a host permission, which is what the
  // reader page's "Allow access" button would otherwise have to ask for.
  //
  // Opened with chrome.tabs.create — exactly how the popup's "Open the PDF reader" link opens it —
  // rather than Playwright's newPage()+goto(): the latter pushes an extra about:blank entry onto the
  // fresh page's session history that a real new tab never carries, which would trip the #back
  // assertion below for a reason that has nothing to do with the reader.
  const readerUrl = `chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent(`${FIXTURE_ORIGIN}/sample.pdf`)}`;
  const sw = ext.context.serviceWorkers()[0] ?? ext.sw;
  const [page] = await Promise.all([ext.context.waitForEvent('page'), sw.evaluate((url: string) => chrome.tabs.create({ url }), readerUrl)]);
  await page.waitForLoadState();

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

  // The progress line only reaches its settled form once the whole run has finished — waited on FIRST,
  // with a real (retrying) expect, so the `.count()` right after reads a judging run that has actually
  // stopped rather than a mid-flight snapshot `.count()` itself would never retry to catch up on.
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);

  // The method paragraph is the one MOCK_FIXTURES pins to core 0.95; only highlights are listed, so
  // its row in the panel is also the proof that its overlay carries jd-hl.
  const highlights = await page.locator('.jd-block.jd-hl').count();
  expect(highlights).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#jd-reader ol li')).toHaveCount(highlights);
  await expect(page.locator('#jd-reader ol li', { hasText: 'The method encodes each input token as a vector' })).toHaveCount(1);
  await expect(page.locator('#jd-reader p.error')).toHaveText('');

  // Clicking a row takes you to its overlay; the flash is the half of that a headless run can assert.
  await page.locator('#jd-reader ol li').first().click();
  await expect(page.locator('.jd-block.jd-flash')).toHaveCount(1);

  // A reader opened in a fresh tab has nothing to go back to — attached (it still exists) but hidden,
  // never just "not found", which toBeHidden() alone would not catch.
  await expect(page.locator('#back')).toBeAttached();
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

test('the reader page reads a PDF picked from disk', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html`);
  await expect(page.locator('#status')).toHaveText('open a PDF from your computer to read it');

  await page.setInputFiles('#file', SAMPLE_PDF);

  // Same assertions as the URL path: a picked file goes through the identical open/render/judge flow.
  await expect(page.locator('.jd-block')).toHaveCount(8);
  await expect(page.locator('.jd-page')).toHaveCount(2);
  await expect(page.locator('.jd-page-mark')).toHaveCount(2);
  await expect(page.locator('h1')).toHaveText('Sample Paper');
  await expect(page.locator('#jd-reader ol li')).not.toHaveCount(0);
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);
  await expect(page.locator('#back')).toBeAttached();
  await expect(page.locator('#back')).toBeHidden();

  await page.close();
});

test('a PDF that fails to parse shows a status instead of hanging, and the picker still works afterward', async () => {
  const page = await ext.context.newPage();
  // article.html fetches fine (real bytes, real 200) but is not a PDF at all — the same failure shape
  // as an HTML interstitial served at a .pdf URL (a login wall, a "this paper moved" page, ...).
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent(`${FIXTURE_ORIGIN}/article.html`)}`);

  await expect(page.locator('#status')).toHaveText(/^can't read this PDF: /);
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('.jd-block')).toHaveCount(0);

  // The picker is never disabled by a failure: picking a real PDF afterward still works.
  await page.setInputFiles('#file', SAMPLE_PDF);
  await expect(page.locator('.jd-block')).toHaveCount(8);
  await expect(page.locator('#status')).not.toHaveClass(/error/);

  await page.close();
});

test('an empty or non-http(s) src is rejected up front, with the picker still available', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent('file:///Users/me/paper.pdf')}`);

  await expect(page.locator('#status')).toHaveText('not a PDF URL');
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('.jd-block')).toHaveCount(0);

  await page.setInputFiles('#file', SAMPLE_PDF);
  await expect(page.locator('.jd-block')).toHaveCount(8);

  await page.close();
});

// §5.3's assets, from the other side: tests/e2e/server.ts's globalSetup guarantees dist/ was built,
// so this is the half of the build assertion that can honestly say "after `pnpm build`".
test("the build ships pdf.js's fonts, cmaps and wasm decoders next to the reader", () => {
  for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
    const dir = path.join(ROOT, 'dist', 'extension', folder);
    expect(existsSync(dir), `dist/extension/${folder} is missing — scripts/build.mjs did not copy it`).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  }
});
