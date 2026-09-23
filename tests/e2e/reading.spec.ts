// End-to-end reading mode: the REAL built extension reading the article fixture, driven from the
// popup exactly as a user would. Its own browser context (Playwright runs spec files one at a time
// here), because extension.spec.ts switches the provider to a live key partway through its run.

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

test('the reader page reads a PDF picked from disk', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html`);
  await expect(page.locator('#status')).toHaveText('open a PDF from your computer to read it');

  await page.setInputFiles('#file', SAMPLE_PDF);

  // Same assertions as the URL path: a picked file goes through the identical parse/render/judge flow.
  await expect(page.locator('.jd-passage')).toHaveCount(8);
  await expect(page.locator('.jd-page-mark')).toHaveCount(2);
  await expect(page.locator('.jd-heading')).toHaveCount(4);
  await expect(page.locator('h1')).toHaveText('Sample Paper');
  await expect(page.locator('.jd-passage', { hasText: 'every position attends to every other position' })).toHaveClass(/jd-hl/);
  await expect(page.locator('#jd-reader ol li')).not.toHaveCount(0);
  await expect(page.locator('#jd-reader .progress')).toHaveText(/^8 passages · /);

  await page.close();
});

test('a PDF that fails to parse shows a status instead of hanging, and the picker still works afterward', async () => {
  const page = await ext.context.newPage();
  // article.html fetches fine (real bytes, real 200) but is not a PDF at all — the same failure shape
  // as an HTML interstitial served at a .pdf URL (a login wall, a "this paper moved" page, ...).
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent(`${FIXTURE_ORIGIN}/article.html`)}`);

  await expect(page.locator('#status')).toHaveText(/^can't read this PDF: /);
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('.jd-passage')).toHaveCount(0);

  // The picker is never disabled by a failure: picking a real PDF afterward still works.
  await page.setInputFiles('#file', SAMPLE_PDF);
  await expect(page.locator('.jd-passage')).toHaveCount(8);
  await expect(page.locator('#status')).not.toHaveClass(/error/);

  await page.close();
});

test('an empty or non-http(s) src is rejected up front, with the picker still available', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/reader.html?src=${encodeURIComponent('file:///Users/me/paper.pdf')}`);

  await expect(page.locator('#status')).toHaveText('not a PDF URL');
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('.jd-passage')).toHaveCount(0);

  await page.setInputFiles('#file', SAMPLE_PDF);
  await expect(page.locator('.jd-passage')).toHaveCount(8);

  await page.close();
});
