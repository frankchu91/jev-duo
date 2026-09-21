import { afterEach, describe, expect, it, vi } from 'vitest';
import { Arbiter } from '../../../src/core/arbiter';
import { AUTO_RECOMPILE_EVERY, DEFAULT_STRICTNESS, JEV_INPUT_USD_PER_MTOK, TIMEOUT_MS } from '../../../src/core/constants';
import { DuoAgent } from '../../../src/core/duo';
import { ExampleStore } from '../../../src/core/learner';
import { createMockJev } from '../../../src/core/providers/jev/mock';
import { createMockLlm } from '../../../src/core/providers/llm/mock';
import { buildState, packQuestions } from '../../../src/core/state';
import type { JevProvider, LlmProvider } from '../../../src/core/providers/types';
import type { Example, Item, QuestionPack, Verdict } from '../../../src/core/types';

/** rage -> fold, promo -> dim, spam -> badge; rust is a keep. Covers every Decision kind. */
function mkPack(overrides: Partial<QuestionPack> = {}): QuestionPack {
  return {
    version: 1,
    intent: 'hide rage, dim promo, badge spam; keep rust',
    compiledAt: 't0',
    compiledBy: 'mock',
    rules: [
      { id: 'rage', label: 'Rage', question: 'This post is ragebait.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] },
      { id: 'promo', label: 'Promo', question: 'This post is a promo.', threshold: 0.7, action: 'dim', ambiguous: [0.45, 0.7] },
      { id: 'spam', label: 'Spam', question: 'This post is spam.', threshold: 0.7, action: 'badge', ambiguous: [0.45, 0.7] },
    ],
    keeps: [{ id: 'rust', label: 'Rust', question: 'This post is about Rust.', threshold: 0.6 }],
    ...overrides,
  };
}

const lowFixture = { r_rage: 0.1, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 };
const mkItem = (id: string): Item => ({ id, platform: 'generic', text: `post ${id}` });

describe('DuoAgent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pack / settings / examples plumbing', () => {
    it('pack getter/setPack expose the injected or assigned pack', () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      expect(agent.pack).toBeUndefined();
      const pack = mkPack();
      agent.setPack(pack);
      expect(agent.pack).toBe(pack);
    });

    it('settings default to {strictness: DEFAULT_STRICTNESS, arbiter: true}; updateSettings merges partial patches', () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      expect(agent.settings).toEqual({ strictness: DEFAULT_STRICTNESS, arbiter: true });
      agent.updateSettings({ strictness: 1 });
      expect(agent.settings).toEqual({ strictness: 1, arbiter: true });
      agent.updateSettings({ arbiter: false });
      expect(agent.settings).toEqual({ strictness: 1, arbiter: false });
    });

    it('DuoAgentOptions.settings seeds the initial settings', () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm(), settings: { arbiter: false } });
      expect(agent.settings).toEqual({ strictness: DEFAULT_STRICTNESS, arbiter: false });
    });

    it('examples getter exposes the live, injected ExampleStore', () => {
      const store = new ExampleStore();
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm(), examples: store });
      expect(agent.examples).toBe(store);
    });

    it('feedback() adds an example and reports shouldRecompile once the auto-recompile threshold is reached', () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      const ex = (id: string): Example => ({ item: mkItem(id), expected: 'hide', actualDecision: { kind: 'keep' }, source: 'user', at: 't' });
      let last = { shouldRecompile: false };
      for (let i = 0; i < AUTO_RECOMPILE_EVERY; i++) last = agent.feedback(ex(`e${i}`));
      expect(agent.examples.size).toBe(AUTO_RECOMPILE_EVERY);
      expect(last.shouldRecompile).toBe(true);
    });
  });

  describe('compile / recompile', () => {
    it('compile(intent) sets pack and marks the example store recompiled', async () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm(), now: () => new Date('2026-09-20T00:00:00Z') });
      agent.feedback({ item: mkItem('x'), expected: 'hide', actualDecision: { kind: 'keep' }, source: 'user', at: 't' });
      expect(agent.examples.sinceRecompile).toBe(1);

      const pack = await agent.compile('Hide ragebait. Keep Rust.');
      expect(agent.pack).toBe(pack);
      expect(pack.rules[0].id).toBe('ragebait');
      expect(pack.compiledAt).toBe('2026-09-20T00:00:00.000Z');
      expect(agent.examples.sinceRecompile).toBe(0);
    });

    it('recompile() compiles pack.intent again, folding in the current examples', async () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm(), now: () => new Date('2026-09-20T00:00:00Z') });
      await agent.compile('Hide ragebait.');
      const before = agent.pack!;
      const repack = await agent.recompile();
      expect(repack.intent).toBe(before.intent);
      expect(repack.rules[0].id).toBe('ragebait');
    });

    it('recompile() throws ProviderError when no pack exists yet', async () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      await expect(agent.recompile()).rejects.toMatchObject({ name: 'ProviderError' });
    });

    it('compile(intent) passes NO examples to the compiler; only recompile() folds in the example list (spec 4.4)', async () => {
      const calls: Array<{ system: string; user: string }> = [];
      const llm: LlmProvider = {
        name: 'fake',
        async completeJson(system: string, user: string) {
          calls.push({ system, user });
          return JSON.stringify({ rules: [{ id: 'a', label: 'A', question: 'This post is a.' }], keeps: [] });
        },
      };
      const agent = new DuoAgent({ jev: createMockJev(), llm });
      agent.feedback({ item: mkItem('x'), expected: 'hide', actualDecision: { kind: 'keep' }, source: 'user', at: 't' });

      await agent.compile('hide a');
      expect(calls).toHaveLength(1);
      expect(calls[0].user).not.toContain('<examples>');

      await agent.recompile();
      expect(calls).toHaveLength(2);
      expect(calls[1].user).toContain('<examples>');
    });
  });

  describe('judge()', () => {
    it('throws ProviderError("no pack") when no pack has been set', async () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      await expect(agent.judge([mkItem('a')])).rejects.toMatchObject({ name: 'ProviderError', message: 'no pack' });
    });

    it('a second judge() call over the same item is served from cache (source:"cache", cacheHits stat)', async () => {
      const pack = mkPack();
      const jev = createMockJev({ fixtures: { a: lowFixture } });
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });

      const [first] = await agent.judge([mkItem('a')]);
      expect(first.source).toBe('jev');
      const [second] = await agent.judge([mkItem('a')]);
      expect(second.source).toBe('cache');
      expect(agent.stats().cacheHits).toBe(1);
      expect(agent.stats().judged).toBe(2);
    });

    it('accumulates judged/folded/dimmed/badged/kept/keptByRule/errors/lastSources from one mixed call', async () => {
      const pack = mkPack();
      const fixtures: Record<string, Record<string, number>> = {
        fold: { r_rage: 0.9, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 },
        dim: { r_rage: 0.1, r_promo: 0.9, r_spam: 0.1, k_rust: 0.1 },
        badge: { r_rage: 0.1, r_promo: 0.1, r_spam: 0.9, k_rust: 0.1 },
        keepRule: { r_rage: 0.1, r_promo: 0.1, r_spam: 0.1, k_rust: 0.9 },
        keepPlain: lowFixture,
      };
      const jev = createMockJev({ fixtures });
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      const items = Object.keys(fixtures).map(mkItem);

      const verdicts = await agent.judge(items);
      expect(verdicts.map((v) => v.decision.kind)).toEqual(['fold', 'dim', 'badge', 'keep', 'keep']);

      const stats = agent.stats();
      expect(stats.judged).toBe(5);
      expect(stats.folded).toBe(1);
      expect(stats.dimmed).toBe(1);
      expect(stats.badged).toBe(1);
      expect(stats.kept).toBe(2);
      expect(stats.keptByRule).toBe(1); // only the keep-rule match (reason "Rust"), not the plain default keep
      expect(stats.errors).toBe(0);
      expect(stats.arbitrated).toBe(0);
      expect(stats.lastSources).toEqual(['jev', 'jev', 'jev', 'jev', 'jev']);
    });

    it('counts a fail-open error verdict and records it in lastSources, without affecting other items', async () => {
      const pack = mkPack();
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          if (req.meta?.itemId === 'bad') throw new Error('boom');
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1 };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      const verdicts = await agent.judge([mkItem('ok'), mkItem('bad')]);
      expect(verdicts.find((v) => v.itemId === 'bad')).toMatchObject({ source: 'error', decision: { kind: 'keep' } });
      expect(agent.stats().errors).toBe(1);
      expect(agent.stats().kept).toBe(2); // both the ok default-keep and the failed-open bad item
      // Order-insensitive on purpose: both items are judged concurrently (CONCURRENCY 6), so which of
      // the two settles first is a race. The sequential-ordering guarantee is pinned by the next test.
      expect([...agent.stats().lastSources].sort()).toEqual(['error', 'jev']);
    });

    it('lastSources orders oldest to newest across separate judge() calls (most recent last)', async () => {
      const pack = mkPack();
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          if (req.meta?.itemId === 'bad') throw new Error('boom');
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1 };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      await agent.judge([mkItem('ok')]);
      await agent.judge([mkItem('bad')]);
      expect(agent.stats().lastSources).toEqual(['jev', 'error']);
    });

    it('lastSources keeps only the most recent 50 final verdict sources', async () => {
      const pack = mkPack();
      const items = Array.from({ length: 55 }, (_, i) => mkItem(`i${i}`));
      const fixtures = Object.fromEntries(items.map((it) => [it.id, lowFixture]));
      const jev = createMockJev({ fixtures });
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      await agent.judge(items);
      const sources = agent.stats().lastSources;
      expect(sources).toHaveLength(50);
      expect(sources.every((s) => s === 'jev')).toBe(true);
    });

    it('a provider that resolves after the timeout leaves no stale usage entry to double-count on a later judge', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const pack = mkPack();
      let settleLate: (() => void) | undefined;
      let call = 0;
      const jev: JevProvider = {
        name: 'fake',
        evaluate(req) {
          call += 1;
          if (call === 1) {
            // Ignores the abort signal entirely (a misbehaving provider) and resolves only when told to.
            return new Promise((resolve) => {
              settleLate = () =>
                resolve({ answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1, usage: { inputTokens: 9999 } });
            });
          }
          return Promise.resolve({ answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1, usage: { inputTokens: 50 } });
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      const item = mkItem('flaky'); // same item id both times

      const firstPromise = agent.judge([item]);
      // judgeOne awaits a real Web Crypto digest (the cache key) before even calling `evaluate` or
      // arming its internal timeout timer; vi.waitFor polls on the REAL clock (unlike
      // advanceTimersByTimeAsync, which only fires timers already registered by the time it runs),
      // so this reliably waits for that real async step to land before the timeout is fast-forwarded.
      await vi.waitFor(() => {
        if (call < 1) throw new Error('evaluate not called yet');
      });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const [first] = await firstPromise;
      expect(first.source).toBe('error');
      expect(agent.stats().inputTokens).toBe(0); // the late write hasn't landed yet, nothing to count

      settleLate?.(); // the abandoned first call finally resolves, well after judge() already returned
      await Promise.resolve();
      await Promise.resolve();

      const [second] = await agent.judge([item]); // errors aren't cached: a real 2nd provider call
      expect(second.source).toBe('jev');
      expect(agent.stats().inputTokens).toBe(50); // only the 2nd call's real usage, not 50 + 9999
      vi.useRealTimers();
    });
  });

  describe('judge() arbitration', () => {
    it('when settings.arbiter is true: a pending verdict is arbitrated, decision + source replace, an example is recorded, onVerdict fires again', async () => {
      const pack = mkPack();
      const jev = createMockJev({ fixtures: { p: { r_rage: 0.55, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 } } });
      const llm: LlmProvider = { name: 'fake', async completeJson() { return JSON.stringify({ hide: true, ruleId: 'rage', why: 'yep' }); } };
      const agent = new DuoAgent({ jev, llm, pack });

      const calls: Verdict[] = [];
      const [v] = await agent.judge([mkItem('p')], (verdict) => calls.push({ ...verdict }));

      expect(v.decision).toEqual({ kind: 'fold', ruleId: 'rage', label: 'Rage', p: 0.55 });
      expect(v.source).toBe('arbiter');
      expect(calls).toHaveLength(2);
      expect(calls[0].decision.kind).toBe('pending-arbiter');
      expect(calls[1].decision).toEqual(v.decision);
      expect(agent.examples.size).toBe(1);
      expect(agent.examples.list()[0].source).toBe('arbiter');
      expect(agent.stats().arbitrated).toBe(1);
      expect(agent.stats().folded).toBe(1);
    });

    it('an arbitrated item still counts its original Jev token cost (the Jev call happened regardless of the later override)', async () => {
      const pack = mkPack();
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          return {
            answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: q.id === 'r_rage' ? 0.55 : 0.1 })),
            latencyMs: 1,
            usage: { inputTokens: 777 },
          };
        },
      };
      const llm: LlmProvider = { name: 'fake', async completeJson() { return JSON.stringify({ hide: true, ruleId: 'rage', why: 'yep' }); } };
      const agent = new DuoAgent({ jev, llm, pack });

      const [v] = await agent.judge([mkItem('p')]);
      expect(v.source).toBe('arbiter'); // the final source, but the Jev call underneath still cost tokens
      expect(agent.stats().inputTokens).toBe(777);
      expect(agent.stats().estimatedUsd).toBeCloseTo((777 * JEV_INPUT_USD_PER_MTOK) / 1e6, 15);
    });

    it('when the arbiter is out of budget: the pending verdict fails open to keep, without changing its source or adding an example', async () => {
      const pack = mkPack();
      const jev = createMockJev({ fixtures: { p: { r_rage: 0.55, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 } } });
      const llm = createMockLlm();
      const arbiter = new Arbiter(llm, { budgetCalls: 0 });
      const agent = new DuoAgent({ jev, llm, pack, arbiter });

      const [v] = await agent.judge([mkItem('p')]);
      expect(v.decision).toEqual({ kind: 'keep' });
      expect(v.source).toBe('jev');
      expect(agent.examples.size).toBe(0);
      expect(agent.stats().arbitrated).toBe(0);
      expect(agent.stats().kept).toBe(1);
      expect(agent.stats().keptByRule).toBe(0);
    });

    it('a throwing arbiter is caught and fails open to keep (judge() never rejects because of it)', async () => {
      const pack = mkPack();
      const jev = createMockJev({ fixtures: { p: { r_rage: 0.55, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 } } });
      const throwingArbiter = {
        arbitrate: () => {
          throw new Error('arbiter exploded');
        },
      } as unknown as Arbiter;
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack, arbiter: throwingArbiter });

      const [v] = await agent.judge([mkItem('p')]);
      expect(v.decision).toEqual({ kind: 'keep' });
      expect(v.source).toBe('jev'); // fail-open only replaces the decision, same as the out-of-budget case
      expect(agent.examples.size).toBe(0);
    });

    it('when settings.arbiter is false: a pending verdict becomes keep immediately, without ever calling the llm', async () => {
      const pack = mkPack();
      const jev = createMockJev({ fixtures: { p: { r_rage: 0.55, r_promo: 0.1, r_spam: 0.1, k_rust: 0.1 } } });
      const completeJson = vi.fn(async () => JSON.stringify({ hide: true, why: 'x' }));
      const llm: LlmProvider = { name: 'fake', completeJson };
      const agent = new DuoAgent({ jev, llm, pack, settings: { arbiter: false } });

      const [v] = await agent.judge([mkItem('p')]);
      expect(v.decision).toEqual({ kind: 'keep' });
      expect(completeJson).not.toHaveBeenCalled();
      expect(agent.examples.size).toBe(0);
    });
  });

  describe('stats(): token/cost accounting', () => {
    it('uses provider-reported usage.inputTokens when present', async () => {
      const pack = mkPack();
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1, usage: { inputTokens: 500 } };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      await agent.judge([mkItem('a')]);
      const stats = agent.stats();
      expect(stats.inputTokens).toBe(500);
      expect(stats.estimatedUsd).toBeCloseTo((500 * JEV_INPUT_USD_PER_MTOK) / 1e6, 15);
    });

    it('estimates inputTokens from JSON(state) and question-statement lengths when usage is absent', async () => {
      const pack = mkPack();
      const item = mkItem('a');
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1 }; // no usage
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      await agent.judge([item]);

      const state = buildState(item);
      const questions = packQuestions(pack);
      const questionChars = questions.reduce((s, q) => s + (q.type === 'noul' ? q.statement.length : 0), 0);
      const expected = Math.ceil(JSON.stringify(state).length / 4) + Math.ceil(questionChars / 4);
      expect(agent.stats().inputTokens).toBe(expected);
      expect(agent.stats().estimatedUsd).toBeCloseTo((expected * JEV_INPUT_USD_PER_MTOK) / 1e6, 15);
    });

    it('does not add token cost for a cache hit (no new provider call)', async () => {
      const pack = mkPack();
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1, usage: { inputTokens: 500 } };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      await agent.judge([mkItem('a')]);
      await agent.judge([mkItem('a')]); // cache hit
      expect(agent.stats().inputTokens).toBe(500);
    });
  });

  describe('stats(): p50LatencyMs', () => {
    // Each item is judged with its own `agent.judge([item])` call, fully awaited before the next
    // starts, and the fake provider advances the fake clock *synchronously inside itself* (via the
    // sync `vi.advanceTimersByTime`, not the async/"run pending timers" variants) by that item's
    // assigned delay. That keeps the clock manipulation strictly ordered after Evaluator's real
    // `await verdictKey(...)` (the cache-key hash) has already resolved and `started = Date.now()`
    // has already been captured for THIS item, with no other item in flight to interfere with the
    // shared clock — so `latencyMs` comes out exactly equal to the assigned delay, deterministically.
    it('is the median of source:"jev" latencies (nearest-rank over an odd count)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const pack = mkPack();
      const delays = [10, 20, 30, 40, 50];
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          vi.advanceTimersByTime(delays.shift()!);
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1 };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      for (let i = 0; i < 5; i++) await agent.judge([mkItem(`i${i}`)]);
      // nearest-rank median of [10,20,30,40,50] (n=5) is the 3rd smallest -> 30
      expect(agent.stats().p50LatencyMs).toBe(30);
    });

    it('keeps only the last 200 source:"jev" latencies for the median', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const pack = mkPack();
      let n = 0;
      const jev: JevProvider = {
        name: 'fake',
        async evaluate(req) {
          n += 1;
          vi.advanceTimersByTime(n); // item 0 -> 1ms (the oldest, dropped once the window fills), item 200 -> 201ms
          return { answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0.1 })), latencyMs: 1 };
        },
      };
      const agent = new DuoAgent({ jev, llm: createMockLlm(), pack });
      for (let i = 0; i < 201; i++) await agent.judge([mkItem(`i${i}`)]);
      // Item 0 (1ms) is the oldest pushed and therefore the one the 200-entry window drops, leaving
      // exactly {2..201}. The nearest-rank median (index 99 of 200, 0-based) of that range is 101.
      expect(agent.stats().p50LatencyMs).toBe(101);
    });

    it('is 0 when no source:"jev" verdict has completed yet', async () => {
      const agent = new DuoAgent({ jev: createMockJev(), llm: createMockLlm() });
      expect(agent.stats().p50LatencyMs).toBe(0);
    });
  });
});
