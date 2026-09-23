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
