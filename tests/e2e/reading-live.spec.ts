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
import { launchWithExtension, seedSettings } from './helpers';
import { FIXTURE_ORIGIN } from './server';

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

    // Addendum 2026-09-23 §2: the field-test document (every paragraph over the absolute line) cannot
    // be fetched offline, so this is the same shape through the fixture — with the REAL provider's own
    // probabilities, which is the half a mock cannot check. Relative, so the assertion is a bound
    // rather than a set: ceil(21 × 0.25) = 6 highlights at most, floor(21 × 0.2) = 4 dims at most, and
    // at least one highlight, because a document that reads as nothing at all would be the regression.
    const highlights = await article.locator('.jd-hl').count();
    expect(highlights).toBeGreaterThanOrEqual(1);
    expect(highlights).toBeLessThanOrEqual(6);
    expect(await article.locator('.jd-dim').count()).toBeLessThanOrEqual(4);
    await expect(article.locator('#jd-reader ol li')).toHaveCount(highlights);
    console.log(`live reading through the extension: ${highlights} highlights of 21 passages`);
  } finally {
    await ext.close();
  }
});
