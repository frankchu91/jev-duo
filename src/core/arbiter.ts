import { ARBITER_BUDGET_CALLS, ARBITER_BUDGET_WINDOW_MS } from './constants';
import { extractJson } from './json';
import { ARBITER_SYSTEM, arbiterUser } from './prompts';
import type { LlmProvider } from './providers/types';
import type { Decision, Example, Item, QuestionPack, Verdict } from './types';

export interface ArbiterOptions {
  budgetCalls?: number;
  windowMs?: number;
  now?: () => number;
}

interface ArbiterReply {
  hide: boolean;
  ruleId?: string;
  why: string;
}

function isArbiterReply(x: unknown): x is ArbiterReply {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.hide === 'boolean' && typeof o.why === 'string' && (o.ruleId === undefined || typeof o.ruleId === 'string');
}

type Pending = Extract<Decision, { kind: 'pending-arbiter' }>;

/** The slow brain's budgeted second opinion on gray-zone (`pending-arbiter`) posts. */
export class Arbiter {
  private readonly budgetCalls: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly callTimestamps: number[] = [];

  constructor(private readonly llm: LlmProvider, opts: ArbiterOptions = {}) {
    this.budgetCalls = opts.budgetCalls ?? ARBITER_BUDGET_CALLS;
    this.windowMs = opts.windowMs ?? ARBITER_BUDGET_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Number of calls still available in the current sliding window. A pure read — it does not prune
   * `callTimestamps` (pruning happens as a side effect of `arbitrate`, where mutation is already
   * expected); the count is correct either way since it only ever counts timestamps still in-window. */
  get remaining(): number {
    const cutoff = this.now() - this.windowMs;
    let inWindow = 0;
    for (const t of this.callTimestamps) if (t > cutoff) inWindow += 1;
    return Math.max(0, this.budgetCalls - inWindow);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] <= cutoff) this.callTimestamps.shift();
  }

  /** Returns null when out of budget or the verdict is not pending-arbiter. */
  async arbitrate(item: Item, pack: QuestionPack, verdict: Verdict): Promise<{ decision: Decision; example: Example } | null> {
    if (verdict.decision.kind !== 'pending-arbiter') return null;
    this.prune();
    if (this.remaining <= 0) return null;
    const pending: Pending = verdict.decision;

    this.callTimestamps.push(this.now());
    let reply: ArbiterReply | undefined;
    try {
      const raw = await this.llm.completeJson(ARBITER_SYSTEM, arbiterUser(item, pack, verdict));
      const json = extractJson(raw);
      if (isArbiterReply(json)) reply = json;
    } catch {
      reply = undefined; // any throw (network error, invalid JSON, ...) fails open below
    }
    if (!reply) return null;

    return {
      decision: this.toDecision(reply, pack, verdict, pending),
      example: { item, expected: reply.hide ? 'hide' : 'show', actualDecision: verdict.decision, source: 'arbiter', at: new Date(this.now()).toISOString() },
    };
  }

  private toDecision(reply: ArbiterReply, pack: QuestionPack, verdict: Verdict, pending: Pending): Decision {
    if (!reply.hide) return { kind: 'keep', reason: 'arbiter' };

    const rule = reply.ruleId !== undefined ? pack.rules.find((r) => r.id === reply.ruleId) : undefined;
    if (rule) {
      const p = verdict.rules.find((rv) => rv.ruleId === rule.id)?.p ?? 0;
      return { kind: rule.action, ruleId: rule.id, label: rule.label, p };
    }

    // Unknown (or omitted) ruleId: fall back to the rule Jev was already unsure about.
    const fallback = pack.rules.find((r) => r.id === pending.ruleId);
    return fallback ? { kind: fallback.action, ruleId: fallback.id, label: fallback.label, p: pending.p } : { kind: 'keep', reason: 'arbiter' };
  }
}
