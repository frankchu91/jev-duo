// End-to-end: the REAL built extension (dist/extension) loaded into Chromium, judging the fixture
// pages that mimic X, Reddit and Hacker News, plus the popup. One browser context for the whole
// file (serial), because every test shares the same background service worker and its persisted
// settings/pack.

import { expect, test } from '@playwright/test';
import {
  compileIntent,
  fixtureUrl,
  getState,
  judged,
  launchWithExtension,
  resetStats,
  seedSettings,
  waitForAtLeastJudged,
  waitForJudged,
  type LaunchedExtension,
} from './helpers';

const INTENT = 'Hide crypto shilling and ragebait. Keep anything about Rust.';

const LIVE = process.env.LIVE === '1';
const JEV_KEY = process.env.TYPESAFE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const JEV_MODE = process.env.TYPESAFE_API_KEY ? 'typesafe' : 'openrouter';

// What the stubbed Jev says about each fixture post: `{ itemId: { questionId: p } }`, exactly the
// shape `Settings.mockFixtures` feeds to createMockJev. The question ids are `r_<ruleId>` for hide
// rules and `k_<keepId>` for keeps (core/state.ts) — asserted against the real compiled pack in the
// first test below. These probabilities are a test oracle, not a claim about the posts: every item
// is pinned so no decision depends on the mock provider's text-overlap heuristic.
const HIT = 0.92; // >= the 0.7 fold threshold
const KEEP = 0.9; // >= the 0.6 keep threshold
const NO = 0.02; // below the 0.45 ambiguous band, so the arbiter is never consulted
const none = { 'r_crypto-shilling': NO, r_ragebait: NO, 'k_anything-about-rust': NO };

const MOCK_FIXTURES: Record<string, Record<string, number>> = {
  'x:1700000000000000001': { ...none, 'r_crypto-shilling': HIT }, // $DOGE2 shill
  'x:1700000000000000002': { ...none, 'r_crypto-shilling': 0.94 }, // $PEPE3000 shill
  'x:1700000000000000003': { ...none, r_ragebait: 0.93 }, // tabs-vs-spaces flamebait
  'x:1700000000000000004': { ...none, 'k_anything-about-rust': KEEP }, // borrow checker
  'x:1700000000000000005': { ...none }, // promoted standing desk
  'x:1700000000000000006': { ...none }, // reposted refactor thread
  'reddit:t3_b1aa11': { ...none },
  'reddit:t3_b1aa22': { ...none },
  'reddit:t3_b1aa33': { ...none, 'k_anything-about-rust': KEEP }, // r/rust release
  'reddit:t3_b1aa44': { ...none, r_ragebait: 0.93 }, // "you won't believe" clickbait
  'hn:41000001': { ...none, r_ragebait: 0.94 },
  'hn:41000002': { ...none },
  'hn:41000003': { ...none, 'k_anything-about-rust': KEEP }, // Rust for Linux
  'hn:41000004': { ...none },
  'hn:41000005': { ...none },
};

test.describe.configure({ mode: 'serial' });

let ext: LaunchedExtension;
let ruleIds: string[] = [];
let keepIds: string[] = [];

test.beforeAll(async () => {
  ext = await launchWithExtension();
  await seedSettings(ext, {
    providerMode: 'mock',
    mockFixtures: MOCK_FIXTURES,
    strictness: 0.5,
    arbiter: true,
    enabledSites: { x: true, reddit: true, hn: true },
  });
  const pack = await compileIntent(ext, INTENT);
  ruleIds = pack.rules.map((r) => r.id);
  keepIds = pack.keeps.map((k) => k.id);
});

test.afterAll(async () => {
  await ext?.close();
});

test('loads the built extension and compiles the intent in the service worker', async () => {
  console.log(`extension loaded ${ext.headless ? 'headless' : 'headed (fallback)'}: ${ext.sw.url()}`);
  expect(ext.sw.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);

  // The fixture map above is keyed off these ids, so a change in the mock compiler shows up here
  // rather than as a mysterious "nothing folded".
  expect(ruleIds).toEqual(['crypto-shilling', 'ragebait']);
  expect(keepIds).toEqual(['anything-about-rust']);

  const state = await getState(ext);
  expect(state.settings.intent).toBe(INTENT);
  expect(state.providers).toEqual({ jev: 'mock', llm: 'mock' });
  expect(state.hasKeys).toBe(false);
});

test('folds the shilling and ragebait tweets on the x fixture, keeps the Rust one', async () => {
  const page = await ext.context.newPage();
  await page.goto(fixtureUrl('x'));
  await waitForJudged(page, 6);

  // 3 folded (two crypto + one ragebait), 1 kept by the Rust keep-rule, 2 plain keeps.
  await expect(page.locator('.jd-bar')).toHaveCount(3);
  await expect(page.locator('.jd-bar').first()).toBeVisible(); // the bar is the only way back to a folded post
  await expect(page.locator('.jd-folded')).toHaveCount(3);
  expect(await page.locator('.jd-bar').evaluateAll((els) => els.map((e) => e.getAttribute('data-jd-rule')))).toEqual([
    'crypto-shilling',
    'crypto-shilling',
    'ragebait',
  ]);

  const rust = page.locator('article[data-testid="tweet"]').nth(3);
  await expect(rust).toBeVisible();
  await expect(rust.locator('.jd-tag')).toHaveText(/kept/);
  await expect(page.locator('.jd-tag')).toHaveCount(1);

  // The promoted tweet and the repost are untouched: not folded, not tagged.
  for (const i of [4, 5]) {
    const other = page.locator('article[data-testid="tweet"]').nth(i);
    await expect(other).toBeVisible();
    await expect(other).not.toHaveClass(/jd-folded/);
    await expect(other.locator('.jd-tag')).toHaveCount(0);
  }

  // "Wrong" reveals the post again and records a correction in the background.
  await page.locator('.jd-bar .jd-wrong').first().click();
  await expect(page.locator('article[data-testid="tweet"]').first()).toBeVisible();
  await expect(page.locator('.jd-folded')).toHaveCount(2);
  await expect.poll(async () => (await getState(ext)).exampleCount).toBe(1);

  await page.close();
});

test('folds the clickbait post on the reddit fixture and skips the ad', async () => {
  const page = await ext.context.newPage();
  await page.goto(fixtureUrl('reddit'));
  await waitForJudged(page, 4); // 4 shreddit-posts; shreddit-ad-post is never judged

  await expect(page.locator('.jd-bar')).toHaveCount(1);
  await expect(page.locator('.jd-bar')).toBeVisible();
  await expect(page.locator('.jd-bar')).toHaveAttribute('data-jd-rule', 'ragebait');
  await expect(page.locator('shreddit-post[id="t3_b1aa44"]')).toBeHidden();
  await expect(page.locator('shreddit-post[id="t3_b1aa33"] .jd-tag')).toHaveText(/kept/);
  await expect(page.locator('shreddit-ad-post .jd-tag, shreddit-ad-post .jd-hide')).toHaveCount(0);

  await page.close();
});

test('folds the whole three-row story block on the hn fixture', async () => {
  const page = await ext.context.newPage();
  await page.goto(fixtureUrl('hn'));
  await waitForJudged(page, 5);

  await expect(page.locator('.jd-bar')).toHaveCount(1);
  // A <div> dropped between two <tr>s is not renderable markup: the HN adapter wraps the bar in a
  // row of its own, and this is what proves the wrapped bar actually shows up on the page.
  await expect(page.locator('.jd-bar')).toBeVisible();
  await expect(page.locator('tr.jd-bar-row')).toHaveCount(1);
  // targets() covers the title row, its subtext row and the spacer, so the whole block disappears.
  await expect(page.locator('.jd-folded')).toHaveCount(3);
  await expect(page.locator('tr[id="41000001"]')).toBeHidden();
  await expect(page.locator('tr[id="41000001"] + tr')).toBeHidden();
  await expect(page.locator('tr[id="41000002"]')).toBeVisible();
  await expect(page.locator('tr[id="41000003"] .jd-tag')).toHaveText(/kept/);

  await page.close();
});

test('popup shows the compiled intent and rules', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);

  await expect(page.locator('h1')).toHaveText('jev-duo');
  await expect(page.locator('#v')).toHaveText('v0.1.0');
  await expect(page.locator('#intent')).toHaveValue(INTENT);
  await expect(page.locator('#rules li')).toHaveCount(3); // 2 hide rules + 1 keep
  await expect(page.locator('#rules li').first()).toContainText('crypto shilling');
  await expect(page.locator('#rules li').last()).toContainText('anything about Rust');
  await expect(page.locator('#brain-status')).toHaveText('fast brain: mock · slow brain: mock');

  await page.close();
});

test('judges the live Hacker News front page', { tag: '@live' }, async () => {
  test.skip(!LIVE, 'set LIVE=1 to run tests that need the public internet');

  await resetStats(ext); // so the counters below describe this page alone

  const page = await ext.context.newPage();
  await page.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded' });
  const count = await waitForAtLeastJudged(page, 20, 15_000);
  console.log(`live hn: ${count} posts judged`);

  await expect(page.locator('[data-jd="pending"]')).toHaveCount(0, { timeout: 15_000 });
  const stats = (await getState(ext)).stats;
  expect(stats.judged).toBeGreaterThanOrEqual(20);
  expect(stats.errors).toBe(0);

  await page.close();
});

test('judges the hn fixture with the real Jev API', { tag: '@live-jev' }, async () => {
  test.skip(!LIVE, 'set LIVE=1 to run tests that need the public internet');
  test.skip(!JEV_KEY, 'set TYPESAFE_API_KEY or OPENROUTER_API_KEY (repo .env is loaded) to run the live Jev test');

  // The pack stays the one the MOCK llm compiled in beforeAll — only the fast brain goes live here.
  // Switching providerMode also drops the verdict cache, so nothing is served from the mock run.
  const key = JEV_KEY ?? '';
  await seedSettings(ext, { providerMode: JEV_MODE, keys: JEV_MODE === 'typesafe' ? { typesafe: key } : { openrouter: key } });
  await resetStats(ext);
  const seeded = await getState(ext);
  expect(seeded.hasKeys).toBe(true);
  expect(seeded.providers.jev).toBe(JEV_MODE);
  // background.ts pairs typesafe-Jev with a mock llm unless an Anthropic key is set, but openrouter
  // mode wires both brains to openrouter — assert whichever pairing this key selected.
  expect(seeded.providers.llm).toBe(JEV_MODE === 'typesafe' ? 'mock' : 'openrouter');

  const page = await ext.context.newPage();
  await page.goto(fixtureUrl('hn'));
  await expect(judged(page)).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('[data-jd="pending"]')).toHaveCount(0, { timeout: 30_000 });

  const stats = (await getState(ext)).stats;
  console.log(`live jev (${JEV_MODE}): ${JSON.stringify(stats)}`);
  expect(stats.judged).toBe(5);
  expect(stats.errors).toBe(0);
  expect(stats.lastSources).toContain('jev');

  await page.close();
});
