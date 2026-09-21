import { DEFAULT_STRICTNESS, STRICTNESS_MAX_THRESHOLD, STRICTNESS_MIN_THRESHOLD } from './constants';
import type { Decision, QuestionPack, RuleVerdict } from './types';

export interface DecideOptions { strictness?: number } // 0 = lenient, 0.5 = neutral, 1 = strict

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Strictness slider maps to a threshold offset of (0.5 - s) * 0.4, clamped to [0.5, 0.95]. */
export function effectiveThreshold(threshold: number, strictness = DEFAULT_STRICTNESS): number {
  return clamp(threshold + (0.5 - strictness) * 0.4, STRICTNESS_MIN_THRESHOLD, STRICTNESS_MAX_THRESHOLD);
}

export function decide(pack: QuestionPack, rules: RuleVerdict[], keeps: RuleVerdict[], opts: DecideOptions = {}): Decision {
  const s = opts.strictness ?? DEFAULT_STRICTNESS;
  const pOf = (xs: RuleVerdict[], id: string) => xs.find((v) => v.ruleId === id)?.p ?? 0;

  for (const k of pack.keeps) if (pOf(keeps, k.id) >= k.threshold) return { kind: 'keep', reason: k.label };

  let best: { p: number; rule: QuestionPack['rules'][number] } | undefined;
  let bestAmbiguous: { p: number; rule: QuestionPack['rules'][number] } | undefined;
  for (const r of pack.rules) {
    const p = pOf(rules, r.id);
    const t = effectiveThreshold(r.threshold, s);
    const low = clamp(r.ambiguous[0] + (0.5 - s) * 0.4, 0.2, t);
    if (p >= t) { if (!best || p > best.p) best = { p, rule: r }; }
    else if (p >= low) { if (!bestAmbiguous || p > bestAmbiguous.p) bestAmbiguous = { p, rule: r }; }
  }
  if (best) return { kind: best.rule.action, ruleId: best.rule.id, label: best.rule.label, p: best.p };
  if (bestAmbiguous) return { kind: 'pending-arbiter', ruleId: bestAmbiguous.rule.id, p: bestAmbiguous.p };
  return { kind: 'keep' };
}
