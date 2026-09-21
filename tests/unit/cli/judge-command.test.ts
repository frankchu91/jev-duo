import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli } from '../../../src/cli/args';
import { run } from '../../../src/cli/commands/judge';
import { compile, createMockLlm } from '../../../src/core/index';

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

  it('exits 1 with a stderr message when --pack is missing', async () => {
    const { flags, positionals } = parseCli(['--input', FIXTURE_INPUT]);
    const { err, stdout, stderr } = captured();

    const code = await run({ flags, positionals, env: {}, stdout, stderr });

    expect(code).toBe(1);
    expect(err.join('')).toMatch(/--pack/);
  });
});
