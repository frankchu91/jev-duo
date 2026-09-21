import { afterEach, describe, expect, it, vi } from 'vitest';
import { LruCache, verdictKey } from '../../../src/core/cache';
import { Evaluator } from '../../../src/core/evaluator';
import { buildState, packQuestions } from '../../../src/core/state';
import type { JevAnswer, JevProvider, JevRequest, JevResponse } from '../../../src/core/providers/types';
import type { Item, QuestionPack, Verdict } from '../../../src/core/types';

function mkPack(compiledAt = 't'): QuestionPack {
  return {
    version: 1,
    intent: 'hide rage, keep rust',
    compiledAt,
    compiledBy: 'mock',
    rules: [{ id: 'rage', label: 'Rage', question: 'This post is ragebait.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] }],
    keeps: [{ id: 'rust', label: 'Rust', question: 'This post is about Rust.', threshold: 0.6 }],
  };
}

const mkItem = (id: string, text = 'some text'): Item => ({ id, platform: 'generic', text });

const zeroAnswers = (req: JevRequest): JevAnswer[] => req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: 0 }));

/** Flushes a real macrotask tick so every currently-pending microtask (including chains of several
 * `await`s across the semaphore/judgeOne/Promise.race) has run, without depending on an exact count
 * of `Promise.resolve()` hops. Safe to use even when fake timers are NOT active. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Evaluator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a cached verdict with source "cache" and never calls the provider', async () => {
    const pack = mkPack();
    const item = mkItem('a');
    const cache = new LruCache<Verdict>(10);
    const cachedVerdict: Verdict = {
      itemId: 'a',
      rules: [{ ruleId: 'rage', p: 0.9 }],
      keeps: [],
      decision: { kind: 'fold', ruleId: 'rage', label: 'Rage', p: 0.9 },
      latencyMs: 3,
      source: 'jev',
    };
    cache.set(await verdictKey(pack, item), cachedVerdict);

    const evaluate = vi.fn();
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { cache });

    const [v] = await evaluator.judge(pack, [item]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(v).toEqual({ ...cachedVerdict, source: 'cache' });
  });

  it('on a cache miss, calls the provider with buildState/packQuestions/meta.itemId and an AbortSignal, splits answers, decides, and caches the jev verdict', async () => {
    const pack = mkPack();
    const item = mkItem('b', 'A post about Rust and rage');
    const cache = new LruCache<Verdict>(10);
    let seenSignal: AbortSignal | undefined;
    const evaluate = vi.fn(async (req: JevRequest, signal?: AbortSignal): Promise<JevResponse> => {
      seenSignal = signal;
      const answers: JevAnswer[] = req.questions.map((q) => ({ id: q.id, type: 'noul', p: q.id === 'r_rage' ? 0.9 : 0.1 }));
      return { answers, latencyMs: 7 };
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { cache });

    const [v] = await evaluator.judge(pack, [item]);

    expect(evaluate).toHaveBeenCalledTimes(1);
    const [req] = evaluate.mock.calls[0];
    expect(req).toEqual({ state: buildState(item), questions: packQuestions(pack), meta: { itemId: 'b' } });
    expect(seenSignal).toBeInstanceOf(AbortSignal);

    expect(v.source).toBe('jev');
    expect(v.rules).toEqual([{ ruleId: 'rage', p: 0.9 }]);
    expect(v.keeps).toEqual([{ ruleId: 'rust', p: 0.1 }]);
    expect(v.decision).toEqual({ kind: 'fold', ruleId: 'rage', label: 'Rage', p: 0.9 });

    const key = await verdictKey(pack, item);
    expect(cache.get(key)).toEqual(v);
  });

  it('does not cache an error verdict, so a later call retries the provider', async () => {
    const pack = mkPack();
    const item = mkItem('flaky');
    const cache = new LruCache<Verdict>(10);
    let calls = 0;
    const evaluate = vi.fn(async (req: JevRequest): Promise<JevResponse> => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return { answers: zeroAnswers(req), latencyMs: 1 };
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { cache });

    const [first] = await evaluator.judge(pack, [item]);
    expect(first.source).toBe('error');
    expect(cache.has(await verdictKey(pack, item))).toBe(false);

    const [second] = await evaluator.judge(pack, [item]);
    expect(second.source).toBe('jev');
    expect(calls).toBe(2);
  });

  it('a cache-key hashing failure degrades to "skip the cache" rather than failing the item', async () => {
    const pack = mkPack();
    const item = mkItem('crypto-fail');
    const cache = new LruCache<Verdict>(10);
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no crypto here'));
    try {
      const evaluate = vi.fn(async (req: JevRequest): Promise<JevResponse> => ({ answers: zeroAnswers(req), latencyMs: 1 }));
      const jev: JevProvider = { name: 'fake', evaluate };
      const evaluator = new Evaluator(jev, { cache });

      const [v] = await evaluator.judge(pack, [item]);
      expect(v.source).toBe('jev'); // the judgment itself still succeeds; only caching is skipped
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(cache.size).toBe(0); // nothing could be cached without a key
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('runs at most `concurrency` provider calls in flight at once (concurrency 2, 5 items)', async () => {
    const pack = mkPack();
    const items = Array.from({ length: 5 }, (_, i) => mkItem(`c${i}`));

    const pending: Array<{ req: JevRequest; resolve: (res: JevResponse) => void }> = [];
    let active = 0;
    let maxActive = 0;
    const evaluate = vi.fn((req: JevRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<JevResponse>((resolve) => {
        pending.push({
          req,
          resolve: (res) => {
            active -= 1;
            resolve(res);
          },
        });
      });
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { concurrency: 2 });

    const resultPromise = evaluator.judge(pack, items);

    await flush();
    expect(evaluate).toHaveBeenCalledTimes(2); // only `concurrency` calls started so far
    expect(active).toBe(2);

    while (pending.length > 0) {
      const next = pending.shift()!;
      next.resolve({ answers: zeroAnswers(next.req), latencyMs: 1 });
      await flush();
    }

    const results = await resultPromise;
    expect(results).toHaveLength(5);
    expect(evaluate).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(2); // the cap was actually reached, not accidentally serialized to 1
  });

  it('aborts via the provided AbortSignal and returns a source:"error" verdict with a /timeout/ message after timeoutMs', async () => {
    vi.useFakeTimers();
    const pack = mkPack();
    const item = mkItem('t1');
    let seenSignal: AbortSignal | undefined;
    const evaluate = vi.fn((_req: JevRequest, signal?: AbortSignal) => {
      seenSignal = signal;
      return new Promise<JevResponse>(() => {}); // never resolves
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { timeoutMs: 1000 });

    const promise = evaluator.judge(pack, [item]);
    const assertion = promise.then(([v]) => {
      expect(v.source).toBe('error');
      expect(v.decision).toEqual({ kind: 'keep' });
      expect(v.error).toMatch(/timeout/);
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  });

  it('a thrown provider error yields source:"error" with decision keep, and other items are unaffected', async () => {
    const pack = mkPack();
    const items = [mkItem('ok'), mkItem('bad')];
    const evaluate = vi.fn(async (req: JevRequest): Promise<JevResponse> => {
      if (req.meta?.itemId === 'bad') throw new Error('provider exploded');
      return { answers: zeroAnswers(req), latencyMs: 2 };
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, {});

    const [okV, badV] = await evaluator.judge(pack, items);
    expect(okV.source).toBe('jev');
    expect(badV.source).toBe('error');
    expect(badV.decision).toEqual({ kind: 'keep' });
    expect(badV.error).toContain('provider exploded');
  });

  it('a synchronously-thrown provider error is also caught and fails open', async () => {
    const pack = mkPack();
    const item = mkItem('sync-throw');
    const jev: JevProvider = {
      name: 'fake',
      evaluate: () => {
        throw new Error('boom');
      },
    };
    const evaluator = new Evaluator(jev, {});
    const [v] = await evaluator.judge(pack, [item]);
    expect(v.source).toBe('error');
    expect(v.decision).toEqual({ kind: 'keep' });
    expect(v.error).toContain('boom');
  });

  it('onVerdict fires once per item in completion order; the returned array preserves input order', async () => {
    const pack = mkPack();
    const items = [mkItem('slow'), mkItem('fast')];
    const resolvers: Record<string, () => void> = {};
    const evaluate = vi.fn(
      (req: JevRequest) =>
        new Promise<JevResponse>((resolve) => {
          resolvers[req.meta!.itemId!] = () => resolve({ answers: zeroAnswers(req), latencyMs: 1 });
        }),
    );
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, { concurrency: 2 });

    const seen: string[] = [];
    const onVerdict = vi.fn((v: Verdict) => seen.push(v.itemId));

    const resultPromise = evaluator.judge(pack, items, onVerdict);
    await flush();
    resolvers.fast(); // resolve the 2nd item before the 1st
    await flush();
    resolvers.slow();

    const results = await resultPromise;
    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['fast', 'slow']); // completion order
    expect(results.map((v) => v.itemId)).toEqual(['slow', 'fast']); // input order preserved
  });

  it('measures latencyMs around the provider call itself, ignoring whatever the provider self-reports', async () => {
    const pack = mkPack();
    const item = mkItem('latency');
    const evaluate = vi.fn(async (req: JevRequest): Promise<JevResponse> => {
      await new Promise((r) => setTimeout(r, 30));
      return { answers: zeroAnswers(req), latencyMs: 999999 };
    });
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, {});
    const [v] = await evaluator.judge(pack, [item]);
    expect(v.latencyMs).toBeGreaterThanOrEqual(20);
    expect(v.latencyMs).toBeLessThan(999999);
  });

  it('treats a question id missing from the answers as p=0 (policy fail-open)', async () => {
    const pack = mkPack();
    const item = mkItem('missing-answers');
    const evaluate = vi.fn(async (): Promise<JevResponse> => ({ answers: [], latencyMs: 1 }));
    const jev: JevProvider = { name: 'fake', evaluate };
    const evaluator = new Evaluator(jev, {});
    const [v] = await evaluator.judge(pack, [item]);
    expect(v.rules).toEqual([]);
    expect(v.keeps).toEqual([]);
    expect(v.decision).toEqual({ kind: 'keep' });
  });

  it('applies the live strictness() getter to the decide() call', async () => {
    const pack = mkPack(); // rage threshold 0.7, ambiguous [0.45, 0.7)
    const item = mkItem('strict');
    const evaluate = vi.fn(async (req: JevRequest): Promise<JevResponse> => ({
      answers: req.questions.map((q) => ({ id: q.id, type: 'noul' as const, p: q.id === 'r_rage' ? 0.55 : 0 })),
      latencyMs: 1,
    }));
    const jev: JevProvider = { name: 'fake', evaluate };
    let strictness = 1; // strictness 1 lowers the effective threshold to 0.5, so p=0.55 now fires directly
    const evaluator = new Evaluator(jev, { strictness: () => strictness });
    const [v] = await evaluator.judge(pack, [item]);
    expect(v.decision).toMatchObject({ kind: 'fold', ruleId: 'rage' });
    strictness = 0; // raises the threshold to 0.9 (and the ambiguous floor to 0.65) -> p=0.55 is plain "keep"
    const [v2] = await evaluator.judge(pack, [mkItem('strict2')]);
    expect(v2.decision).toEqual({ kind: 'keep' });
  });
});
