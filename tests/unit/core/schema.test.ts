import { describe, it, expect } from 'vitest';
import { parsePack, LlmPackOutputSchema } from '../../../src/core/schema';

const good = {
  version: 1, intent: 'hide ragebait', compiledAt: '2026-09-20T00:00:00.000Z', compiledBy: 'mock',
  rules: [{ id: 'ragebait', label: 'ragebait', question: 'This post is designed to provoke outrage.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] }],
  keeps: [],
};

describe('parsePack', () => {
  it('accepts a valid pack', () => { expect(parsePack(good).rules[0].id).toBe('ragebait'); });
  it('rejects a rule with threshold > 1', () => {
    expect(() => parsePack({ ...good, rules: [{ ...good.rules[0], threshold: 1.2 }] })).toThrow();
  });
  it('rejects duplicate rule ids', () => {
    expect(() => parsePack({ ...good, rules: [good.rules[0], good.rules[0]] })).toThrow(/duplicate/i);
  });
  it('rejects unknown action', () => {
    expect(() => parsePack({ ...good, rules: [{ ...good.rules[0], action: 'nuke' }] })).toThrow();
  });
});

describe('LlmPackOutputSchema', () => {
  it('applies defaults for threshold, action and ambiguous', () => {
    const out = LlmPackOutputSchema.parse({ rules: [{ id: 'a', label: 'a', question: 'This post is a.' }], keeps: [{ id: 'k', label: 'k', question: 'This post is k.' }] });
    expect(out.rules[0].threshold).toBe(0.7);
    expect(out.rules[0].action).toBe('fold');
    expect(out.keeps[0].threshold).toBe(0.6);
  });
  it('truncates labels longer than 24 chars', () => {
    const out = LlmPackOutputSchema.parse({ rules: [{ id: 'a', label: 'x'.repeat(40), question: 'q' }], keeps: [] });
    expect(out.rules[0].label).toHaveLength(24);
  });
  it('clamps thresholds into [0.5, 0.95]', () => {
    const out = LlmPackOutputSchema.parse({ rules: [{ id: 'a', label: 'a', question: 'q', threshold: 0.2 }], keeps: [] });
    expect(out.rules[0].threshold).toBe(0.5);
  });
});
