import { describe, it, expect } from 'vitest';
import { decide, effectiveThreshold } from '../../../src/core/policy';
import type { QuestionPack } from '../../../src/core/types';

const pack: QuestionPack = {
  version: 1, intent: '', compiledAt: 't', compiledBy: 'mock',
  rules: [
    { id: 'rage', label: 'ragebait', question: 'q', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] },
    { id: 'promo', label: 'promo', question: 'q', threshold: 0.7, action: 'dim', ambiguous: [0.45, 0.7] },
  ],
  keeps: [{ id: 'rust', label: 'rust', question: 'q', threshold: 0.6 }],
};

describe('decide', () => {
  it('keeps when nothing fires', () => {
    expect(decide(pack, [{ ruleId: 'rage', p: 0.1 }, { ruleId: 'promo', p: 0.2 }], [{ ruleId: 'rust', p: 0.1 }])).toEqual({ kind: 'keep' });
  });
  it('applies the highest-probability hide rule', () => {
    const d = decide(pack, [{ ruleId: 'rage', p: 0.75 }, { ruleId: 'promo', p: 0.9 }], []);
    expect(d).toEqual({ kind: 'dim', ruleId: 'promo', label: 'promo', p: 0.9 });
  });
  it('a keep hit overrides every hide', () => {
    const d = decide(pack, [{ ruleId: 'rage', p: 0.99 }], [{ ruleId: 'rust', p: 0.61 }]);
    expect(d).toEqual({ kind: 'keep', reason: 'rust' });
  });
  it('returns pending-arbiter inside the ambiguous band', () => {
    expect(decide(pack, [{ ruleId: 'rage', p: 0.5 }], [])).toEqual({ kind: 'pending-arbiter', ruleId: 'rage', p: 0.5 });
  });
  it('treats a missing verdict as p=0 (fail-open)', () => {
    expect(decide(pack, [], [])).toEqual({ kind: 'keep' });
  });
  it('strictness 1 lowers thresholds by 0.2, strictness 0 raises by 0.2, clamped', () => {
    expect(effectiveThreshold(0.7, 1)).toBeCloseTo(0.5);
    expect(effectiveThreshold(0.7, 0)).toBeCloseTo(0.9);
    expect(effectiveThreshold(0.9, 0)).toBeCloseTo(0.95);
    expect(effectiveThreshold(0.7, 0.5)).toBeCloseTo(0.7);
    expect(decide(pack, [{ ruleId: 'rage', p: 0.55 }], [], { strictness: 1 })).toMatchObject({ kind: 'fold', ruleId: 'rage' });
  });
});
