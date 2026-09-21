import { describe, it, expect } from 'vitest';
import { renderTable, renderJsonl } from '../../../src/cli/render';
import type { DuoStats, Item, Verdict } from '../../../src/core/index';

function item(id: string, text: string): Item {
  return { id, platform: 'generic', text };
}

function stats(overrides: Partial<DuoStats> = {}): DuoStats {
  return {
    judged: 0, folded: 0, dimmed: 0, badged: 0, kept: 0, keptByRule: 0,
    errors: 0, cacheHits: 0, arbitrated: 0, p50LatencyMs: 0, estimatedUsd: 0,
    inputTokens: 0, lastSources: [], ...overrides,
  };
}

describe('renderTable', () => {
  it('renders a folded line: rank, glyph, "label p%", title', () => {
    const items = [item('a', 'Buy this new crypto token now')];
    const verdicts: Verdict[] = [
      { itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'fold', ruleId: 'crypto', label: 'crypto', p: 0.87 } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ⚡ ${'crypto 87%'.padEnd(14)} Buy this new crypto token now`;
    expect(line).toBe(expected);
  });

  it('renders a dimmed line', () => {
    const items = [item('b', 'Announcing our new product launch today')];
    const verdicts: Verdict[] = [
      { itemId: 'b', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'dim', ruleId: 'launch', label: 'product launch', p: 0.71 } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ◐ ${'product launch 71%'.padEnd(14)} Announcing our new product launch today`;
    expect(line).toBe(expected);
  });

  it('renders a badged line', () => {
    const items = [item('c', 'Some post that gets flagged')];
    const verdicts: Verdict[] = [
      { itemId: 'c', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'badge', ruleId: 'flagged', label: 'flagged', p: 0.75 } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ◦ ${'flagged 75%'.padEnd(14)} Some post that gets flagged`;
    expect(line).toBe(expected);
  });

  it('renders a plain keep with an empty label column', () => {
    const items = [item('d', 'A neutral cooking post about pasta')];
    const verdicts: Verdict[] = [
      { itemId: 'd', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ✓ ${''.padEnd(14)} A neutral cooking post about pasta`;
    expect(line).toBe(expected);
  });

  it('renders a keep-by-rule line with the star glyph and an empty label column', () => {
    const items = [item('e', 'The new Rust release has async traits')];
    const verdicts: Verdict[] = [
      { itemId: 'e', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep', reason: 'Rust' } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ★ ${''.padEnd(14)} The new Rust release has async traits`;
    expect(line).toBe(expected);
  });

  it('renders an error line (fail-open keep from source:"error") with the error glyph', () => {
    const items = [item('f', 'A post whose judgment timed out')];
    const verdicts: Verdict[] = [
      { itemId: 'f', rules: [], keeps: [], source: 'error', latencyMs: 10000, error: 'timeout after 10000ms', decision: { kind: 'keep' } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    const expected = `${'1'.padStart(2)} ! ${''.padEnd(14)} A post whose judgment timed out`;
    expect(line).toBe(expected);
  });

  it('renders an arbiter-resolved keep as a plain keep, not keep-by-rule', () => {
    const items = [item('g', 'Ambiguous post resolved by the arbiter')];
    const verdicts: Verdict[] = [
      { itemId: 'g', rules: [], keeps: [], source: 'arbiter', latencyMs: 5, decision: { kind: 'keep', reason: 'arbiter' } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    expect(line).toContain('✓');
    expect(line).not.toContain('★');
  });

  it('truncates the title to 80 characters', () => {
    const longText = 'x'.repeat(200);
    const items = [item('h', longText)];
    const verdicts: Verdict[] = [
      { itemId: 'h', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } },
    ];
    const [line] = renderTable(items, verdicts).split('\n');
    expect(line.endsWith('x'.repeat(80))).toBe(true);
    expect(line.endsWith('x'.repeat(81))).toBe(false);
  });

  // An HN story with a body arrives as "title\n\nbody", and a raw slice of that put the body on its
  // own lines, splitting one item across several rows of a table that is one line per item.
  it('collapses whitespace so an item whose text has newlines still renders on one line', () => {
    const items = [item('i', 'Show HN: my thing\n\nSorry for the   long   post, here is why')];
    const verdicts: Verdict[] = [
      { itemId: 'i', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } },
    ];
    const rendered = renderTable(items, verdicts);
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(2); // the item plus the stats footer, nothing in between
    expect(lines[0]).toBe(`${'1'.padStart(2)} ✓ ${''.padEnd(14)} Show HN: my thing Sorry for the long post, here is why`);
  });

  it('numbers multiple items by rank in input order', () => {
    const items = [item('a', 'first'), item('b', 'second'), item('c', 'third')];
    const verdicts: Verdict[] = items.map((it): Verdict => ({ itemId: it.id, rules: [], keeps: [], source: 'jev', latencyMs: 1, decision: { kind: 'keep' } }));
    const lines = renderTable(items, verdicts).split('\n').slice(0, 3);
    expect(lines[0].startsWith(' 1 ')).toBe(true);
    expect(lines[1].startsWith(' 2 ')).toBe(true);
    expect(lines[2].startsWith(' 3 ')).toBe(true);
  });

  it('dims folded lines with ANSI codes when color is true, and leaves other lines plain', () => {
    const items = [item('a', 'crypto token launch'), item('b', 'a neutral post')];
    const verdicts: Verdict[] = [
      { itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'fold', ruleId: 'crypto', label: 'crypto', p: 0.9 } },
      { itemId: 'b', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } },
    ];
    const lines = renderTable(items, verdicts, { color: true }).split('\n');
    expect(lines[0].startsWith('\x1b[2m')).toBe(true);
    expect(lines[0].endsWith('\x1b[0m')).toBe(true);
    expect(lines[1].startsWith('\x1b[2m')).toBe(false);
  });

  it('does not dim folded lines when color is false or omitted', () => {
    const items = [item('a', 'crypto token launch')];
    const verdicts: Verdict[] = [
      { itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'fold', ruleId: 'crypto', label: 'crypto', p: 0.9 } },
    ];
    const lines = renderTable(items, verdicts).split('\n');
    expect(lines[0].includes('\x1b[')).toBe(false);
  });

  it('appends a footer line summarising the given DuoStats', () => {
    const items = [item('a', 'x')];
    const verdicts: Verdict[] = [{ itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } }];
    const s = stats({ judged: 10, folded: 3, dimmed: 1, kept: 6, errors: 0, p50LatencyMs: 42, estimatedUsd: 0.0012 });
    const lines = renderTable(items, verdicts, { stats: s }).split('\n');
    const footer = lines[lines.length - 1];
    expect(footer).toBe('judged 10 · folded 3 · dimmed 1 · kept 6 · errors 0 · p50 42ms · ~$0.0012');
  });

  it('computes footer counts from the verdicts themselves when no stats are given', () => {
    const items = [item('a', 'crypto'), item('b', 'neutral')];
    const verdicts: Verdict[] = [
      { itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 10, decision: { kind: 'fold', ruleId: 'crypto', label: 'crypto', p: 0.9 } },
      { itemId: 'b', rules: [], keeps: [], source: 'jev', latencyMs: 20, decision: { kind: 'keep' } },
    ];
    const lines = renderTable(items, verdicts).split('\n');
    const footer = lines[lines.length - 1];
    expect(footer).toContain('judged 2');
    expect(footer).toContain('folded 1');
    expect(footer).toContain('kept 1');
  });
});

describe('renderJsonl', () => {
  it('prints one JSON object per line, one per verdict, in order', () => {
    const verdicts: Verdict[] = [
      { itemId: 'a', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'fold', ruleId: 'crypto', label: 'crypto', p: 0.9 } },
      { itemId: 'b', rules: [], keeps: [], source: 'jev', latencyMs: 5, decision: { kind: 'keep' } },
    ];
    const out = renderJsonl(verdicts);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(verdicts[0]);
    expect(JSON.parse(lines[1])).toEqual(verdicts[1]);
  });

  it('returns an empty string for no verdicts', () => {
    expect(renderJsonl([])).toBe('');
  });
});
