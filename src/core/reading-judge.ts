// Reading mode's fast brain (design addendum §4.3): one Jev call per passage, six in flight, a 10 s
// per-call timeout, no retries, an LRU cache keyed by title|focus|text, and fail-open on anything
// that goes wrong. Deliberately not the Evaluator: there is no pack, no strictness, no arbiter and no
// DuoStats here, and the cache key is text-shaped rather than pack-shaped.
//
// The provider identity is NOT part of the cache key, exactly as in background.ts's verdict cache —
// which is why the background throws the whole judge away when the provider or a key changes (§9)
// rather than trying to invalidate entries.

import { LruCache, sha256Hex } from './cache';
import { semaphore } from './evaluator';
import type { JevProvider, JevQuestion, JevRequest, JevResponse } from './providers/types';
import { decideReading, readingQuestions, readingState, type DocContext, type Passage, type ReadingVerdict } from './reading';

export const READING_CONCURRENCY = 6;
export const READING_TIMEOUT_MS = 10_000;
export const READING_CACHE_SIZE = 2000;
/** §3.1. The panel prints this under the summary line, so it has to fit on one: a provider that
 * answers a failure with a whole HTML page would otherwise push the panel off the screen. */
const LAST_ERROR_MAX = 200;

export interface ReadingJudgeOptions {
  concurrency?: number;
  timeoutMs?: number;
  cacheSize?: number;
}

export interface ReadingRun {
  verdicts: ReadingVerdict[];
  usageTokens: number;
  errors: number;
  ms: number;
  /** The message of the most recent call that failed (§3.1); absent when none did. */
  lastError?: string;
}

export class ReadingJudge {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly cache: LruCache<ReadingVerdict>;

  constructor(
    private readonly jev: JevProvider,
    opts: ReadingJudgeOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? READING_CONCURRENCY;
    this.timeoutMs = opts.timeoutMs ?? READING_TIMEOUT_MS;
    this.cache = new LruCache<ReadingVerdict>(opts.cacheSize ?? READING_CACHE_SIZE);
  }

  /** Judges every passage. Never rejects: one passage's failure is its own plain verdict and nothing
   * else's problem. `verdicts` comes back in passage order however the calls finished, one per input
   * passage; `onVerdict` fires once per passage as each one resolves, which is what lets the panel fill
   * in while the rest is still running. */
  async judge(ctx: DocContext, focus: string, passages: Passage[], onVerdict?: (v: ReadingVerdict) => void): Promise<ReadingRun> {
    const started = Date.now();
    const hasFocus = focus.trim() !== '';
    const questions = readingQuestions(focus);
    const verdicts: ReadingVerdict[] = new Array<ReadingVerdict>(passages.length);
    const acquire = semaphore(this.concurrency);
    let usageTokens = 0;
    let errors = 0;
    let lastError: string | undefined;

    // One call per DISTINCT id (§3: `rd:` + fnv1a of the first 300 characters), not per passage. A
    // document that repeats a paragraph verbatim — a legal note, a quoted block, a boilerplate footer —
    // hands the same id to every copy, and the cache cannot collapse them on its own: nothing is stored
    // until a call RESOLVES, and every passage checks the cache before any of them has an answer, so all
    // of them missed and all of them were billed. Verdicts are keyed by id everywhere downstream (the
    // reader decorates by id), so a per-copy verdict could never have said anything different anyway.
    const groups = new Map<string, { passage: Passage; at: number[] }>();
    for (const [i, passage] of passages.entries()) {
      const group = groups.get(passage.id);
      if (group) group.at.push(i);
      else groups.set(passage.id, { passage, at: [i] });
    }

    /** One verdict to every passage that shares its id, still in passage order. Each passage gets its
     * own copy rather than an alias: this array is handed to callers and structured-cloned across the
     * extension's message port, and two entries pointing at one object is a trap nobody expects. */
    const fanOut = (at: number[], verdict: ReadingVerdict): void => {
      for (const i of at) {
        const own: ReadingVerdict = { ...verdict };
        verdicts[i] = own;
        onVerdict?.(own);
      }
    };

    await Promise.all(
      [...groups.values()].map(async ({ passage, at }) => {
        const key = await this.keyFor(ctx, focus, passage);
        const cached = key === undefined ? undefined : this.cache.get(key);
        if (cached) {
          // A hit costs no call and no tokens. The id is re-stamped defensively: the key is text-shaped
          // and the id is derived from that same text, so they always agree, but nothing here depends
          // on that staying true.
          fanOut(at, { ...cached, id: passage.id });
          return;
        }

        const release = await acquire();
        try {
          const res = await this.callOne(ctx, questions, passage);
          const verdict = decideReading(passage.id, res.answers, hasFocus);
          usageTokens += res.usage?.inputTokens ?? 0;
          if (key !== undefined) this.cache.set(key, verdict);
          fanOut(at, verdict);
        } catch (err) {
          // Fail open (§2): the passage is shown exactly as the document rendered it. Never cached —
          // a transient failure must not pin a passage to "plain" for the rest of the session. Counted
          // once per passage, not once per call: `errors` is what the panel's "N errors" line sits
          // next to "M passages", and every one of these passages did go unjudged.
          errors += at.length;
          // §3.1: the LAST failure wins. Ten passages failing the same way all carry the same message,
          // and when they do not, the most recent one is the one the reader can still act on.
          lastError = (err instanceof Error ? err.message : String(err)).slice(0, LAST_ERROR_MAX);
          fanOut(at, { id: passage.id, verdict: 'plain', p: 0.5, core: 0.5, error: true });
        } finally {
          release();
        }
      }),
    );

    return { verdicts, usageTokens, errors, lastError, ms: Date.now() - started };
  }

  /** Best-effort cache key: no Web Crypto (an insecure context) degrades to "always a miss" rather
   * than failing the read — the same rule the evaluator's cache follows. */
  private async keyFor(ctx: DocContext, focus: string, passage: Passage): Promise<string | undefined> {
    try {
      return await sha256Hex(`${ctx.title}|${focus}|${passage.text}`);
    } catch {
      return undefined;
    }
  }

  private async callOne(ctx: DocContext, questions: JevQuestion[], passage: Passage): Promise<JevResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const req: JevRequest = { state: readingState(ctx, passage), questions, meta: { itemId: passage.id } };
      const call = this.jev.evaluate(req, controller.signal);
      call.catch(() => {}); // swallow a late rejection from the losing side of the race below
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });
      return await Promise.race([call, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
