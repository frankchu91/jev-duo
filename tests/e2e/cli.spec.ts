// End-to-end for the CLI: the REAL built binary (dist/cli/index.js) run as a subprocess from the
// repo root, never the TypeScript sources. `compile` and `judge` are pinned to mock providers so
// they stay deterministic and offline even when the owner's .env has real keys; the tests that do
// need the network (`demo`, and the live Jev judge) skip themselves explicitly.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { QuestionPack, Verdict } from '../../src/core/types';
import { ROOT } from './helpers';

const execFileAsync = promisify(execFile);
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const ITEMS = 'tests/e2e/fixtures/items.jsonl';
const INTENT = 'Hide crypto shilling and ragebait. Keep anything about Rust.';

const LIVE = process.env.LIVE === '1';
const JEV_KEY = process.env.TYPESAFE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const JEV_MODE = process.env.TYPESAFE_API_KEY ? 'typesafe' : 'openrouter';

interface CliResult { code: number; stdout: string; stderr: string }

/** Runs the built CLI from the repo root. Never rejects: a non-zero exit is a result, not an error. */
async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const MOCK = ['--provider', 'mock', '--llm', 'mock'];
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');
const lines = (s: string): string[] => stripAnsi(s).trim().split('\n');

let tmpDir: string;
let packPath: string;

test.beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'jev-duo-cli-'));
  packPath = path.join(tmpDir, 'pack.json');
  const res = await cli(['compile', INTENT, ...MOCK, '--out', packPath]);
  expect(res.code, res.stderr).toBe(0);
});

test.afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

test('--version prints the package version', async () => {
  const res = await cli(['--version']);
  expect(res.code).toBe(0);
  expect(res.stdout.trim()).toBe('0.1.0');
});

test('compile turns an intent into a question pack on stdout', async () => {
  const res = await cli(['compile', 'hide crypto', ...MOCK]);
  expect(res.code, res.stderr).toBe(0);

  const pack = JSON.parse(res.stdout) as QuestionPack;
  expect(pack.version).toBe(1);
  expect(pack.intent).toBe('hide crypto');
  expect(pack.compiledBy).toBe('mock');
  expect(pack.rules[0].id).toBe('crypto');
  expect(pack.rules[0].action).toBe('fold');
});

test('judge folds the crypto items from the fixture jsonl', async () => {
  const res = await cli(['judge', '--pack', packPath, '--input', ITEMS, ...MOCK]);
  expect(res.code, res.stderr).toBe(0);

  const out = lines(res.stdout);
  expect(out).toHaveLength(9); // 8 items + the stats footer
  expect(out[0]).toContain('⚡ crypto shilling');
  expect(out[0]).toContain('DogeMoon');
  expect(out[5]).toContain('★'); // the Rust item, kept by the keep-rule
  expect(out[8]).toMatch(/^judged 8 · folded 2 · dimmed 0 · kept 6 · errors 0 · p50 \d+ms · ~\$\d+\.\d{4}$/);
});

test('judge --json emits one verdict per line, fx:1 folded', async () => {
  const res = await cli(['judge', '--pack', packPath, '--input', ITEMS, ...MOCK, '--json']);
  expect(res.code, res.stderr).toBe(0);

  const verdicts = lines(res.stdout).map((l) => JSON.parse(l) as Verdict);
  expect(verdicts).toHaveLength(8);
  expect(verdicts.map((v) => v.itemId)).toEqual(['fx:1', 'fx:2', 'fx:3', 'fx:4', 'fx:5', 'fx:6', 'fx:7', 'fx:8']);
  expect(verdicts[0].decision).toMatchObject({ kind: 'fold', ruleId: 'crypto-shilling' });
  expect(verdicts[1].decision.kind).toBe('fold');
  expect(verdicts[5].decision).toMatchObject({ kind: 'keep', reason: 'anything about Rust' });
  expect(verdicts.every((v) => v.source === 'jev')).toBe(true);
});

test('an unknown command exits 1 with usage', async () => {
  const res = await cli(['frobnicate']);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain('unknown command "frobnicate"');
  expect(res.stderr).toContain('Usage:');
});

// The showcase command: the whole loop (compile an intent, judge a feed, print the table) with no
// keys AND no network, so it is the same eight verdicts on every machine.
test('demo judges the bundled sample feed with no keys and no network', async () => {
  const res = await cli(['demo'], { OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '' });
  expect(res.code, res.stderr).toBe(0);

  const out = lines(res.stdout);
  expect(out[0]).toBe('jev-duo demo — mock providers, bundled sample feed');
  expect(out).toHaveLength(10); // header + 8 posts + stats footer
  expect(out.filter((l) => l.includes('⚡'))).toHaveLength(4); // crypto x2, political outrage, layoffs
  expect(out.filter((l) => l.includes('◐'))).toHaveLength(1); // the product launch, dimmed
  expect(out[9]).toBe('judged 8 · folded 4 · dimmed 1 · kept 3 · errors 0 · p50 0ms · ~$0.0000');
});

test('an invalid --limit exits 1 with a usage error instead of silently using the default', async () => {
  const res = await cli(['hn', '--rules', 'hide crypto', '--limit', '0', ...MOCK]);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain('--limit must be an integer between 1 and 100');
  expect(res.stdout).toBe('');
});

test.describe('network', () => {
  let online = false;

  test.beforeAll(async () => {
    if (!LIVE && process.env.CI) return; // CI only reaches the public internet with LIVE=1
    online = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1', {
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.ok, () => false);
  });

  test('demo --live judges the live Hacker News front page with no keys', async () => {
    test.skip(!online, 'hn.algolia.com unreachable (or CI without LIVE=1)');

    const res = await cli(['demo', '--live'], { OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '' });
    expect(res.code, res.stderr).toBe(0);

    const out = lines(res.stdout);
    expect(out[0]).toBe('jev-duo demo — mock providers, Hacker News front page');
    expect(out.length).toBeGreaterThanOrEqual(10);
    expect(out[out.length - 1]).toMatch(/^judged \d+ · folded \d+ /);
  });
});

test('judges the fixture items with the real Jev API', { tag: '@live-jev' }, async () => {
  test.skip(!LIVE, 'set LIVE=1 to run tests that need the public internet');
  test.skip(!JEV_KEY, 'set TYPESAFE_API_KEY or OPENROUTER_API_KEY (repo .env is loaded) to run the live Jev test');

  const res = await cli(['judge', '--pack', packPath, '--input', ITEMS, '--provider', JEV_MODE, '--llm', 'mock', '--json']);
  expect(res.code, res.stderr).toBe(0);

  const verdicts = lines(res.stdout).map((l) => JSON.parse(l) as Verdict);
  expect(verdicts).toHaveLength(8);
  for (const v of verdicts) {
    // 'arbiter' is the only other source a live run can produce: a probability inside the ambiguous
    // band is escalated to the (mock) slow brain, which still counts as a real Jev call underneath.
    expect(['jev', 'arbiter']).toContain(v.source);
    for (const { p } of [...v.rules, ...v.keeps]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  }
  expect(verdicts.some((v) => v.source === 'jev')).toBe(true);
  expect(verdicts[0].decision.kind).toBe('fold');
  expect(verdicts[1].decision.kind).toBe('fold');

  console.log(`live jev cli (${JEV_MODE}):\n${stripAnsi(res.stdout)}`);
});
