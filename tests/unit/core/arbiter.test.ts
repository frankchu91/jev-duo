import { describe, expect, it } from 'vitest';
import { Arbiter } from '../../../src/core/arbiter';
import { ARBITER_SYSTEM, arbiterUser } from '../../../src/core/prompts';
import type { LlmProvider } from '../../../src/core/providers/types';
import type { Item, QuestionPack, Verdict } from '../../../src/core/types';

function mkPack(): QuestionPack {
  return {
    version: 1,
    intent: 'hide rage, dim promo',
    compiledAt: 't',
    compiledBy: 'mock',
    rules: [
      { id: 'rage', label: 'Rage', question: 'This post is ragebait.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] },
      { id: 'promo', label: 'Promo', question: 'This post is promo.', threshold: 0.7, action: 'dim', ambiguous: [0.45, 0.7] },
    ],
    keeps: [],
  };
}

const item: Item = { id: 'x:1', platform: 'x', text: 'hello' };

/** A pending-arbiter verdict whose `verdict.rules` carries `p` for BOTH pack rules, so tests can tell
 * apart "used the pending rule's p" from "looked up a different rule's p in verdict.rules". */
function pendingVerdict(ruleId: 'rage' | 'promo', p: number): Verdict {
  return {
    itemId: item.id,
    rules: [
      { ruleId: 'rage', p: ruleId === 'rage' ? p : 0.1 },
      { ruleId: 'promo', p: ruleId === 'promo' ? p : 0.1 },
    ],
    keeps: [],
    decision: { kind: 'pending-arbiter', ruleId, p },
    latencyMs: 5,
    source: 'jev',
  };
}

/** Scripted LlmProvider: returns replies[i] for the i-th call (repeating the last reply after the
 * list runs out) and counts how many times it was called. */
function fakeLlm(replies: string[]): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    name: 'fake',
    get calls() {
      return calls;
    },
    async completeJson(): Promise<string> {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      return reply;
    },
  };
}

describe('Arbiter', () => {
  it('returns null immediately, without calling the llm, when the verdict is not pending-arbiter', async () => {
    const llm = fakeLlm(['{"hide":true,"why":"x"}']);
    const arbiter = new Arbiter(llm);
    const kept: Verdict = { ...pendingVerdict('rage', 0.5), decision: { kind: 'keep' } };
    expect(await arbiter.arbitrate(item, mkPack(), kept)).toBeNull();
    expect(llm.calls).toBe(0);
  });

  it('calls the llm with ARBITER_SYSTEM and arbiterUser(item, pack, verdict)', async () => {
    const pack = mkPack();
    const verdict = pendingVerdict('rage', 0.55);
    let seen: { system: string; user: string } | undefined;
    const llm: LlmProvider = {
      name: 'fake',
      async completeJson(system: string, user: string) {
        seen = { system, user };
        return JSON.stringify({ hide: false, why: 'ok' });
      },
    };
    const arbiter = new Arbiter(llm);
    await arbiter.arbitrate(item, pack, verdict);
    expect(seen?.system).toBe(ARBITER_SYSTEM);
    expect(seen?.user).toBe(arbiterUser(item, pack, verdict));
  });

  it('hide:true with a known ruleId resolves to that rule\'s action/label, using verdict.rules\' p for that rule (not the pending rule\'s p)', async () => {
    const pack = mkPack();
    const verdict = pendingVerdict('rage', 0.55); // rage p=0.55 (pending), promo p=0.1 in verdict.rules
    const llm = fakeLlm([JSON.stringify({ hide: true, ruleId: 'promo', why: 'actually promo' })]);
    const arbiter = new Arbiter(llm);
    const result = await arbiter.arbitrate(item, pack, verdict);
    expect(result?.decision).toEqual({ kind: 'dim', ruleId: 'promo', label: 'Promo', p: 0.1 });
    expect(result?.example).toEqual({ item, expected: 'hide', actualDecision: verdict.decision, source: 'arbiter', at: expect.any(String) });
  });

  it('hide:true with an unknown ruleId falls back to the verdict\'s pending ruleId', async () => {
    const pack = mkPack();
    const verdict = pendingVerdict('rage', 0.6);
    const llm = fakeLlm([JSON.stringify({ hide: true, ruleId: 'not-a-real-rule', why: 'x' })]);
    const arbiter = new Arbiter(llm);
    const result = await arbiter.arbitrate(item, pack, verdict);
    expect(result?.decision).toEqual({ kind: 'fold', ruleId: 'rage', label: 'Rage', p: 0.6 });
  });

  it('hide:true with no ruleId at all falls back to the verdict\'s pending ruleId', async () => {
    const pack = mkPack();
    const verdict = pendingVerdict('promo', 0.65);
    const llm = fakeLlm([JSON.stringify({ hide: true, why: 'x' })]);
    const arbiter = new Arbiter(llm);
    const result = await arbiter.arbitrate(item, pack, verdict);
    expect(result?.decision).toEqual({ kind: 'dim', ruleId: 'promo', label: 'Promo', p: 0.65 });
  });

  it('hide:false resolves to keep with reason "arbiter" and an example expecting "show"', async () => {
    const pack = mkPack();
    const verdict = pendingVerdict('rage', 0.55);
    const llm = fakeLlm([JSON.stringify({ hide: false, why: 'fine actually' })]);
    const arbiter = new Arbiter(llm);
    const result = await arbiter.arbitrate(item, pack, verdict);
    expect(result?.decision).toEqual({ kind: 'keep', reason: 'arbiter' });
    expect(result?.example.expected).toBe('show');
    expect(result?.example.source).toBe('arbiter');
  });

  it('invalid JSON from the llm returns null but still counts against the budget', async () => {
    const llm = fakeLlm(['not json at all']);
    const arbiter = new Arbiter(llm, { budgetCalls: 5 });
    expect(arbiter.remaining).toBe(5);
    const result = await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(result).toBeNull();
    expect(arbiter.remaining).toBe(4);
  });

  it('a reply missing required fields is invalid too: returns null and still counts against the budget', async () => {
    const llm = fakeLlm([JSON.stringify({ ruleId: 'rage' })]); // no `hide`, no `why`
    const arbiter = new Arbiter(llm, { budgetCalls: 5 });
    const result = await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(result).toBeNull();
    expect(arbiter.remaining).toBe(4);
  });

  it('remaining counts down per call and the call returns null once the budget is exhausted', async () => {
    const llm = fakeLlm([JSON.stringify({ hide: false, why: 'ok' })]);
    const arbiter = new Arbiter(llm, { budgetCalls: 2 });
    expect(arbiter.remaining).toBe(2);
    await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(arbiter.remaining).toBe(1);
    await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(arbiter.remaining).toBe(0);
    const result = await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(result).toBeNull();
    expect(llm.calls).toBe(2); // the 3rd call never reached the llm
  });

  it('the window slides: calls older than windowMs stop counting against the budget', async () => {
    let now = 1_000_000;
    const llm = fakeLlm([JSON.stringify({ hide: false, why: 'ok' })]);
    const arbiter = new Arbiter(llm, { budgetCalls: 1, windowMs: 1000, now: () => now });

    await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(arbiter.remaining).toBe(0);

    now += 999;
    expect(arbiter.remaining).toBe(0); // still inside the window

    now += 2; // 1001ms after the call -> outside a 1000ms window
    expect(arbiter.remaining).toBe(1);
  });

  it('a thrown/rejected llm call also returns null and counts against the budget (fail-open)', async () => {
    const llm: LlmProvider = {
      name: 'fake',
      async completeJson() {
        throw new Error('network down');
      },
    };
    const arbiter = new Arbiter(llm, { budgetCalls: 5 });
    const result = await arbiter.arbitrate(item, mkPack(), pendingVerdict('rage', 0.5));
    expect(result).toBeNull();
    expect(arbiter.remaining).toBe(4);
  });
});
