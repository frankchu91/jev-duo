import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCli } from '../../../src/cli/args';
import { run } from '../../../src/cli/commands/judge';
import { compile, createMockLlm, type Verdict } from '../../../src/core/index';

const FIXTURE_INPUT = 'tests/e2e/fixtures/items.jsonl';

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}

describe('judge command', () => {
  let dir: string;
  let packPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jev-duo-judge-'));
    packPath = join(dir, 'pack.json');
    const pack = await compile('Hide crypto and token launches.', createMockLlm());
    await writeFile(packPath, JSON.stringify(pack), 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('judges the fixture file with mock providers, prints a folded crypto line, and exits 0', async () => {
    const { flags, positionals } = parseCli(['--pack', packPath, '--input', FIXTURE_INPUT]);
    const { out, err, stdout, stderr } = captured();

    const code = await run({ flags, positionals, env: {}, stdout, stderr });

    expect(code).toBe(0);
    const table = out.join('');
    const cryptoLine = table.split('\n').find((l) => l.includes('DogeMoon'));
    expect(cryptoLine).toBeDefined();
    expect(cryptoLine).toContain('⚡'); // fold glyph
    expect(err.join('')).toMatch(/no API key found, using mock providers/);
  });

  it('skips an invalid JSONL line from stdin with a stderr warning, and still judges the valid ones', async () => {
    const validItem1 = { id: 'x:1', platform: 'generic', text: 'a valid item about databases' };
    const validItem2 = { id: 'x:2', platform: 'generic', text: 'another valid item about rust' };
    const raw = ['not valid json {{{', JSON.stringify(validItem1), JSON.stringify(validItem2)].join('\n');

    const { flags, positionals } = parseCli(['--pack', packPath]);
    const { out, err, stdout, stderr } = captured();

    const code = await run({ flags, positionals, env: {}, stdout, stderr, readStdin: async () => raw });

    expect(code).toBe(0);
    expect(err.some((line) => /invalid/i.test(line))).toBe(true);
    const table = out.join('');
    const itemLines = table.trimEnd().split('\n').slice(0, -1); // drop the footer line
    expect(itemLines).toHaveLength(2);
  });

  // Spec §4.5: the arbiter is off by default on the CLI, where one command judges dozens of posts at
  // once and every gray-zone escalation is an LLM call the user never asked for.
  describe('--arbiter', () => {
    /** A rule the mock fast brain lands squarely inside the ambiguous band on (p ~= 0.46 against the
     * item below), which is the only case that ever reaches the arbiter. */
    const GRAY_PACK = {
      version: 1,
      intent: 'hide gray',
      compiledAt: '2026-01-01T00:00:00.000Z',
      compiledBy: 'mock',
      rules: [{ id: 'gray', label: 'Gray', question: 'This post is about databases, quantum computing and pasta.', threshold: 0.7, action: 'fold', ambiguous: [0.2, 0.7] }],
      keeps: [],
    };
    const GRAY_ITEM = { id: 'fx:7', platform: 'generic', text: 'A deep dive into how modern databases handle query planning, indexing, and replication in PostgreSQL 17' };

    /** An OpenRouter chat completion whose content is the arbiter's JSON reply. */
    const arbiterReply = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"hide":true,"ruleId":"gray","why":"it is about databases"}' }}] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    async function judgeGray(extraArgs: string[], fetchImpl: typeof fetch): Promise<Verdict> {
      const grayPackPath = join(dir, 'gray-pack.json');
      const grayItemPath = join(dir, 'gray-item.jsonl');
      await writeFile(grayPackPath, JSON.stringify(GRAY_PACK), 'utf8');
      await writeFile(grayItemPath, JSON.stringify(GRAY_ITEM), 'utf8');

      const { flags, positionals } = parseCli(['--pack', grayPackPath, '--input', grayItemPath, '--provider', 'mock', '--llm', 'openrouter', '--json', ...extraArgs]);
      const { out, stdout, stderr } = captured();
      const code = await run({ flags, positionals, env: { OPENROUTER_API_KEY: 'or-key' }, stdout, stderr, fetchImpl });
      expect(code).toBe(0);
      return JSON.parse(out.join('').trim()) as Verdict;
    }

    it('by default never calls the slow brain: an ambiguous post just stays visible', async () => {
      const fetchImpl = vi.fn<typeof fetch>();
      const verdict = await judgeGray([], fetchImpl);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(verdict.decision).toEqual({ kind: 'keep' });
      expect(verdict.source).toBe('jev');
    });

    it('with --arbiter, the same post is escalated and the slow brain\'s answer wins', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(arbiterReply());
      const verdict = await judgeGray(['--arbiter'], fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(verdict.decision).toMatchObject({ kind: 'fold', ruleId: 'gray' });
      expect(verdict.source).toBe('arbiter');
    });
  });

  it('exits 1 with a stderr message when --pack is missing', async () => {
    const { flags, positionals } = parseCli(['--input', FIXTURE_INPUT]);
    const { err, stdout, stderr } = captured();

    const code = await run({ flags, positionals, env: {}, stdout, stderr });

    expect(code).toBe(1);
    expect(err.join('')).toMatch(/--pack/);
  });
});
