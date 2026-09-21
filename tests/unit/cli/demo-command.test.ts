import { describe, expect, it, vi } from 'vitest';
import { parseCli } from '../../../src/cli/args';
import { run } from '../../../src/cli/commands/demo';
import { SAMPLE_FEED } from '../../../src/cli/sample-feed';

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('demo command', () => {
  it('judges the bundled sample feed with no network and no keys', async () => {
    const { flags, positionals } = parseCli(['demo']);
    const { out, err, stdout, stderr } = captured();
    const fetchImpl = vi.fn<typeof fetch>(); // never called: the default demo is entirely offline

    const code = await run({ flags, positionals, env: {}, stdout, stderr, fetchImpl });

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err.join('')).toBe('');

    const lines = stripAnsi(out.join('')).trimEnd().split('\n');
    expect(lines[0]).toBe('jev-duo demo — mock providers, bundled sample feed');
    expect(lines).toHaveLength(1 + SAMPLE_FEED.length + 1); // header + one line per post + the stats footer
    expect(lines.filter((l) => l.includes('⚡'))).toHaveLength(4); // crypto x2, political outrage, layoffs
    expect(lines.filter((l) => l.includes('◐'))).toHaveLength(1); // the product launch is dimmed, not folded
    expect(lines[lines.length - 1]).toBe('judged 8 · folded 4 · dimmed 1 · kept 3 · errors 0 · p50 0ms · ~$0.0000');
  });

  it('--live judges the Hacker News front page instead, under its own header', async () => {
    const { flags, positionals } = parseCli(['demo', '--live', '--limit', '2']);
    const { out, stdout, stderr } = captured();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ hits: [{ objectID: '1', title: 'Rust 1.90 released', url: 'https://example.com/rust', points: 9, num_comments: 1, author: 'a' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const code = await run({ flags, positionals, env: {}, stdout, stderr, fetchImpl });

    expect(code).toBe(0);
    const lines = stripAnsi(out.join('')).trimEnd().split('\n');
    expect(lines[0]).toBe('jev-duo demo — mock providers, Hacker News front page');
    expect(lines[1]).toContain('Rust 1.90 released');
    expect(fetchImpl.mock.calls[0][0]).toContain('hitsPerPage=2');
  });
});
