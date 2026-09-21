import type { LruCache } from './cache';
import { verdictKey } from './cache';
import { CONCURRENCY, DEFAULT_STRICTNESS, TIMEOUT_MS } from './constants';
import { decide } from './policy';
import { buildState, packQuestions } from './state';
import type { JevAnswer, JevProvider, JevRequest } from './providers/types';
import type { Item, QuestionPack, RuleVerdict, Verdict } from './types';

export interface EvaluatorOptions {
  concurrency?: number;
  timeoutMs?: number;
  cache?: LruCache<Verdict>;
  strictness?: () => number;
}

export type VerdictListener = (v: Verdict, item: Item) => void;

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Counting semaphore: `acquire()` resolves with a `release()` callback once a slot is free. Keeps
 * at most `max` callers running past their `await acquire()` at any time; excess callers queue FIFO. */
function semaphore(max: number): () => Promise<() => void> {
  let active = 0;
  const queue: Array<() => void> = [];
  return () =>
    new Promise((resolve) => {
      const grant = () => {
        active += 1;
        resolve(() => {
          active -= 1;
          queue.shift()?.();
        });
      };
      if (active < max) grant();
      else queue.push(grant);
    });
}

interface CacheLookup {
  key: string;
  cached: Verdict | undefined;
}

function splitAnswers(answers: JevAnswer[]): { rules: RuleVerdict[]; keeps: RuleVerdict[] } {
  const rules: RuleVerdict[] = [];
  const keeps: RuleVerdict[] = [];
  for (const a of answers) {
    if (a.type !== 'noul') continue; // packQuestions only ever emits noul questions
    if (a.id.startsWith('r_')) rules.push({ ruleId: a.id.slice(2), p: a.p });
    else if (a.id.startsWith('k_')) keeps.push({ ruleId: a.id.slice(2), p: a.p });
  }
  return { rules, keeps };
}

/** The fast brain's loop: judges every item against a pack, concurrently, with an LRU cache and a
 * per-item timeout. Never rejects and never lets one item's failure affect another's — any provider
 * throw or timeout yields `source: 'error'`, `decision: { kind: 'keep' }` (fail-open). */
export class Evaluator {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly cache?: LruCache<Verdict>;
  private readonly strictness: () => number;

  constructor(private readonly jev: JevProvider, opts: EvaluatorOptions = {}) {
    this.concurrency = opts.concurrency ?? CONCURRENCY;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.cache = opts.cache;
    this.strictness = opts.strictness ?? (() => DEFAULT_STRICTNESS);
  }

  async judge(pack: QuestionPack, items: Item[], onVerdict?: VerdictListener): Promise<Verdict[]> {
    const results: Verdict[] = new Array(items.length);
    const acquire = semaphore(this.concurrency);
    await Promise.all(
      items.map(async (item, i) => {
        const release = await acquire();
        try {
          const v = await this.judgeOne(pack, item);
          results[i] = v;
          onVerdict?.(v, item);
        } finally {
          release();
        }
      }),
    );
    return results;
  }

  /** Best-effort cache read: a hashing failure (e.g. no Web Crypto in an insecure context) or a
   * throwing cache implementation degrades to "no cached verdict" rather than failing the whole
   * judgment — never rejects. */
  private async tryCacheGet(pack: QuestionPack, item: Item): Promise<CacheLookup | undefined> {
    if (!this.cache) return undefined;
    try {
      const key = await verdictKey(pack, item);
      return { key, cached: this.cache.get(key) };
    } catch {
      return undefined;
    }
  }

  /** Best-effort cache write: a throwing cache must not turn an otherwise-good verdict into an error. */
  private tryCacheSet(key: string | undefined, verdict: Verdict): void {
    if (!this.cache || key === undefined) return;
    try {
      this.cache.set(key, verdict);
    } catch {
      // best effort only; a broken cache implementation must never affect the verdict itself
    }
  }

  private async judgeOne(pack: QuestionPack, item: Item): Promise<Verdict> {
    const lookup = await this.tryCacheGet(pack, item);
    if (lookup?.cached) {
      // Re-decide at the CURRENT strictness: a cache hit still needs to reflect a settings change
      // made after the verdict was cached, even though Jev itself isn't called again.
      const decision = decide(pack, lookup.cached.rules, lookup.cached.keeps, { strictness: this.strictness() });
      return { ...lookup.cached, decision, source: 'cache' };
    }

    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const req: JevRequest = { state: buildState(item), questions: packQuestions(pack), meta: { itemId: item.id } };
      const evalPromise = this.jev.evaluate(req, controller.signal);
      evalPromise.catch(() => {}); // swallow a late rejection from the losing side of the timeout race
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });

      const response = await Promise.race([evalPromise, timedOut]);
      const latencyMs = Date.now() - started;
      const { rules, keeps } = splitAnswers(response.answers);
      const decision = decide(pack, rules, keeps, { strictness: this.strictness() });
      const verdict: Verdict = { itemId: item.id, rules, keeps, decision, latencyMs, source: 'jev' };
      this.tryCacheSet(lookup?.key, verdict);
      return verdict;
    } catch (err) {
      const latencyMs = Date.now() - started;
      return { itemId: item.id, rules: [], keeps: [], decision: { kind: 'keep' }, latencyMs, source: 'error', error: describeError(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
