import { describe, it, expect } from 'vitest';
import { compile } from '../../../src/core/compiler';
import { ARBITER_SYSTEM, COMPILE_SYSTEM, arbiterUser, compileUser } from '../../../src/core/prompts';
import { createMockLlm } from '../../../src/core/providers/llm/mock';
import { ProviderError, type LlmProvider } from '../../../src/core/providers/types';
import type { Decision, Example, Item, QuestionPack, Verdict } from '../../../src/core/types';

/** Tiny scripted LlmProvider: returns replies[i] for the i-th call (the last reply repeats after
 * the list runs out) and records every (system, user) pair it was called with, in order. */
function fakeLlm(replies: string[]): LlmProvider & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    name: 'fake',
    calls,
    async completeJson(system: string, user: string): Promise<string> {
      const reply = replies[Math.min(calls.length, replies.length - 1)];
      calls.push({ system, user });
      return reply;
    },
  };
}

const validPackJson = JSON.stringify({
  rules: [{ id: 'a', label: 'A', question: 'This post is about a.' }],
  keeps: [],
  notes: 'ok',
});

describe('compile', () => {
  it('(a) compiles via the mock llm: ids from splitIntent, defaults, compiledAt/compiledBy', async () => {
    const pack = await compile('Hide ragebait. Keep Rust.', createMockLlm(), {
      now: () => new Date('2026-09-20T00:00:00Z'),
    });
    expect(pack.rules[0].id).toBe('ragebait');
    // splitIntent (src/core/providers/llm/mock.ts) slugifies "Rust" -> id "rust" (label stays "Rust");
    // verified directly against splitIntent's output before writing this assertion.
    expect(pack.keeps[0].id).toBe('rust');
    expect(pack.compiledAt).toBe('2026-09-20T00:00:00.000Z');
    expect(pack.compiledBy).toBe('mock');
    expect(pack.rules[0].threshold).toBe(0.7);
    expect(pack.rules[0].ambiguous).toEqual([0.45, 0.7]);
  });

  it('(b) retries once on invalid output and succeeds once a valid reply arrives', async () => {
    const llm = fakeLlm(['garbage', validPackJson]);
    const pack = await compile('hide spam', llm);
    expect(pack.rules[0].id).toBe('a');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].user).toContain('previous output was invalid');
    // the retry prompt still carries the original intent tags, not just the error tail
    expect(llm.calls[1].user).toContain('<intent>\nhide spam\n</intent>');
  });

  it('(c) rejects with /invalid pack/ when every reply is invalid', async () => {
    const llm = fakeLlm(['garbage']);
    await expect(compile('hide spam', llm)).rejects.toThrow(/invalid pack from fake/);
    await expect(compile('hide spam', fakeLlm(['garbage']))).rejects.toBeInstanceOf(ProviderError);
    expect(llm.calls).toHaveLength(2); // original attempt + one retry, then give up
  });

  it('(d) rejects an empty/whitespace intent without ever calling the llm', async () => {
    const llm = fakeLlm([validPackJson]);
    await expect(compile('', llm)).rejects.toThrow(/empty intent/);
    await expect(compile('   \n\t  ', llm)).rejects.toThrow(/empty intent/);
    expect(llm.calls).toHaveLength(0);
  });

  it('(e) folds prior corrections into the compile prompt as an <examples> block', async () => {
    const llm = fakeLlm([validPackJson]);
    const item: Item = { id: 'x:1', platform: 'x', text: 'Buy my token now, 100x guaranteed' };
    const example: Example = {
      item,
      expected: 'hide',
      actualDecision: { kind: 'keep' },
      source: 'user',
      at: '2026-09-19T00:00:00.000Z',
    };
    await compile('hide crypto shilling', llm, { examples: [example] });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toContain('<examples>');
    expect(llm.calls[0].user).toContain('Buy my token now, 100x guaranteed');
  });

  it('(f) dedupes ids across rules and keeps, appending -2 then -3', async () => {
    const dup = JSON.stringify({
      rules: [
        { id: 'x', label: 'X', question: 'This post is x.' },
        { id: 'x', label: 'X2', question: 'This post is also x.' },
      ],
      keeps: [{ id: 'x', label: 'X3', question: 'This post is x, a keep.' }],
    });
    const pack = await compile('hide x', fakeLlm([dup]));
    expect(pack.rules.map((r) => r.id)).toEqual(['x', 'x-2']);
    expect(pack.keeps.map((k) => k.id)).toEqual(['x-3']);
  });

  it('rejects when the llm produces neither rules nor keeps', async () => {
    const empty = JSON.stringify({ rules: [], keeps: [] });
    await expect(compile('do nothing', fakeLlm([empty]))).rejects.toThrow(/no rules produced/);
  });
});

describe('compileUser', () => {
  it('wraps the intent in <intent> tags and omits <examples> when there are none', () => {
    const prompt = compileUser('hide spam', []);
    expect(prompt).toContain('<intent>\nhide spam\n</intent>');
    expect(prompt).not.toContain('<examples>');
    expect(prompt.trim().endsWith('Return only the JSON object.')).toBe(true);
  });

  it('includes an <examples> block with one JSON line per example, keyed by whatFired', () => {
    const item: Item = { id: 'x:1', platform: 'x', text: 'hello world' };
    const foldDecision: Decision = { kind: 'fold', ruleId: 'ragebait', label: 'Ragebait', p: 0.9 };
    const firedExample: Example = {
      item,
      expected: 'hide',
      actualDecision: foldDecision,
      source: 'user',
      at: '2026-09-19T00:00:00.000Z',
    };
    const nothingFiredExample: Example = {
      item,
      expected: 'show',
      actualDecision: { kind: 'keep' },
      source: 'user',
      at: '2026-09-19T00:00:00.000Z',
    };
    const prompt = compileUser('hide ragebait', [firedExample, nothingFiredExample]);
    expect(prompt).toContain('<examples>');
    expect(prompt).toContain('</examples>');
    expect(prompt).toContain('"whatFired":"ragebait"');
    expect(prompt).toContain('"expected":"hide"');
    expect(prompt).toContain('"whatFired":"nothing"');
  });
});

describe('arbiterUser', () => {
  it('wraps the payload in <arbiter> tags with post, rules, keeps and fastModel', () => {
    const item: Item = { id: 'x:1', platform: 'x', author: 'someone', text: 'hello world' };
    const pack: QuestionPack = {
      version: 1,
      intent: 'hide spam',
      compiledAt: '2026-09-20T00:00:00.000Z',
      compiledBy: 'mock',
      rules: [{ id: 'r', label: 'R', question: 'This post is r.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] }],
      keeps: [],
    };
    const verdict: Verdict = {
      itemId: 'x:1',
      rules: [{ ruleId: 'r', p: 0.65 }],
      keeps: [],
      decision: { kind: 'pending-arbiter', ruleId: 'r', p: 0.65 },
      latencyMs: 5,
      source: 'jev',
    };
    const prompt = arbiterUser(item, pack, verdict);
    expect(prompt.startsWith('<arbiter>\n')).toBe(true);
    expect(prompt.endsWith('\n</arbiter>')).toBe(true);
    const json = JSON.parse(prompt.slice('<arbiter>\n'.length, -'\n</arbiter>'.length));
    expect(json).toEqual({
      post: { platform: 'x', author: 'someone', text: 'hello world' },
      rules: [{ id: 'r', label: 'R', question: 'This post is r.' }],
      keeps: [],
      fastModel: { rules: [{ ruleId: 'r', p: 0.65 }], keeps: [] },
    });
  });
});

describe('prompt constants', () => {
  it('COMPILE_SYSTEM and ARBITER_SYSTEM read as ONLY-JSON instructions (guards against accidental edits)', () => {
    expect(COMPILE_SYSTEM).toContain('Output: ONLY a JSON object, no prose, no code fences');
    expect(COMPILE_SYSTEM).toContain('two-brain feed filter');
    expect(ARBITER_SYSTEM).toContain('Output ONLY JSON');
    expect(ARBITER_SYSTEM).toContain('two-brain feed filter');
  });
});
