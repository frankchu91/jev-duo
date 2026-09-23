import { describe, expect, it } from 'vitest';
import type { JevProvider, JevRequest, JevResponse } from '../../../src/core/providers/types';
import { createMockJev } from '../../../src/core/providers/jev/mock';
import { passageId, type DocContext, type Passage, type ReadingVerdict } from '../../../src/core/reading';
import { ReadingJudge } from '../../../src/core/reading-judge';

const CTX: DocContext = { title: 'Sample Paper', lead: 'A lead paragraph.', source: 'https://example.test/p' };

function passages(...texts: string[]): Passage[] {
  return texts.map((text, index) => ({ id: passageId(text), index, text }));
}

/** A provider whose every answer is fixed, that records each request and reports the high-water mark
 * of concurrent calls. `gate` (when given) holds every call open until it is resolved. */
function stubJev(opts: { p?: number; usage?: number; gate?: Promise<void> } = {}): JevProvider & {
  requests: JevRequest[];
  maxInFlight: number;
} {
  let inFlight = 0;
  const stub = {
    name: 'stub',
    requests: [] as JevRequest[],
    maxInFlight: 0,
    async evaluate(req: JevRequest): Promise<JevResponse> {
      stub.requests.push(req);
      inFlight += 1;
      stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
      try {
        await (opts.gate ?? Promise.resolve());
        return {
          answers: req.questions.map((q) => (q.type === 'noul' ? { id: q.id, type: 'noul' as const, p: opts.p ?? 0.9 } : { id: q.id, type: 'choice' as const, choice: 'claim', probabilities: { claim: 1 }, confidence: 1 })),
          latencyMs: 1,
          usage: { inputTokens: opts.usage ?? 100 },
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return stub;
}

describe('ReadingJudge', () => {
  it('returns verdicts in passage order and fires onVerdict once per passage', async () => {
    const jev = stubJev();
    const seen: ReadingVerdict[] = [];
    const items = passages('first passage text', 'second passage text', 'third passage text');
    const run = await new ReadingJudge(jev).judge(CTX, '', items, (v) => seen.push(v));

    expect(run.verdicts.map((v) => v.id)).toEqual(items.map((p) => p.id));
    expect(run.verdicts.every((v) => v.verdict === 'highlight')).toBe(true);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((v) => v.id))).toEqual(new Set(items.map((p) => p.id)));
    expect(run.errors).toBe(0);
    expect(run.usageTokens).toBe(300);
    expect(run.ms).toBeGreaterThanOrEqual(0);
  });

  it('sends one request per passage, with the passage id as meta.itemId', async () => {
    const jev = stubJev();
    const items = passages('alpha passage', 'beta passage');
    await new ReadingJudge(jev).judge(CTX, 'what is beta', items);

    expect(jev.requests).toHaveLength(2);
    expect(jev.requests.map((r) => r.meta?.itemId).sort()).toEqual(items.map((p) => p.id).sort());
    expect(jev.requests[0].questions.map((q) => q.id)).toEqual(['core', 'focus', 'kind']);
    expect(jev.requests[0].state).toEqual({ document_title: 'Sample Paper', document_lead: 'A lead paragraph.', passage: expect.any(String) });
  });

  it('serves a repeat run from the cache: no second call and no tokens', async () => {
    const jev = stubJev();
    const judge = new ReadingJudge(jev);
    const items = passages('cached passage text goes here');

    const first = await judge.judge(CTX, '', items);
    const second = await judge.judge(CTX, '', items);

    expect(jev.requests).toHaveLength(1);
    expect(second.verdicts).toEqual(first.verdicts);
    expect(second.usageTokens).toBe(0);
  });

  it('keys the cache on the focus too, so changing the question re-asks', async () => {
    const jev = stubJev();
    const judge = new ReadingJudge(jev);
    const items = passages('cached passage text goes here');

    await judge.judge(CTX, '', items);
    await judge.judge(CTX, 'a different question', items);

    expect(jev.requests).toHaveLength(2);
  });

  it('keeps at most 6 calls in flight', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const jev = stubJev({ gate });
    const items = passages(...Array.from({ length: 20 }, (_, i) => `passage number ${i} with enough text`));

    const running = new ReadingJudge(jev).judge(CTX, '', items);
    await Promise.resolve();
    await Promise.resolve();
    open();
    await running;

    expect(jev.maxInFlight).toBeLessThanOrEqual(6);
    expect(jev.requests).toHaveLength(20);
  });

  it('turns a timeout into a plain verdict with error:true, counted in errors', async () => {
    // A real (short) timeout rather than fake timers: the cache lookup runs a real Web Crypto digest
    // (sha256Hex) before the provider is even called, and that digest never resolves under
    // vi.useFakeTimers() (its default toFake list captures globals the digest's own completion
    // depends on) regardless of how far the fake clock is advanced afterwards. A small real timeoutMs
    // exercises the same fail-open path deterministically and keeps the test fast.
    const hung: JevProvider = { name: 'hung', evaluate: () => new Promise<JevResponse>(() => {}) };
    const items = passages('a passage that never gets an answer');

    const run = await new ReadingJudge(hung, { timeoutMs: 10 }).judge(CTX, '', items);

    expect(run.errors).toBe(1);
    expect(run.verdicts[0]).toEqual({ id: items[0].id, verdict: 'plain', p: 0.5, core: 0.5, error: true });
  });

  it('turns a throwing provider into the same fail-open verdict, and never caches it', async () => {
    let calls = 0;
    const flaky: JevProvider = {
      name: 'flaky',
      async evaluate(): Promise<JevResponse> {
        calls += 1;
        throw new Error('boom');
      },
    };
    const judge = new ReadingJudge(flaky);
    const items = passages('a passage whose provider explodes every time');

    expect((await judge.judge(CTX, '', items)).verdicts[0].error).toBe(true);
    await judge.judge(CTX, '', items);
    expect(calls).toBe(2); // a failure is never remembered as a verdict
  });

  // --- Final wave, IMPORTANT: §3's id is fnv1a over the passage's first 300 characters, so a document
  // that repeats a paragraph verbatim (a legal note, a quoted block) hands several passages one id.
  // The cache could not help: nothing is stored until a call RESOLVES, and every passage checks the
  // cache before any of them has an answer, so all of them missed and all of them paid for a call. One
  // call per distinct id now, its verdict fanned out to every passage that shares it.
  //
  // These tests hold every call open on a gate and only release it once each passage has been past the
  // cache check — which is exactly the shape of a real read, where the provider is a network away. A
  // free-running stub answers the first passage before the second has even hashed its cache key, so it
  // would show one call whether or not the dedup exists. ---

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

  it('makes one provider call for N identical passages and still returns N verdicts', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const jev = stubJev({ gate });
    const text = 'The same legal note, repeated verbatim in several places in this document.';
    const items: Passage[] = Array.from({ length: 10 }, (_, index) => ({ id: passageId(text), index, text }));
    const seen: ReadingVerdict[] = [];

    const running = new ReadingJudge(jev).judge(CTX, '', items, (v) => seen.push(v));
    await settle();
    open();
    const run = await running;

    expect(jev.requests).toHaveLength(1); // one call, not ten
    expect(run.usageTokens).toBe(100); // and one call's worth of tokens
    expect(run.verdicts).toHaveLength(10);
    expect(run.verdicts.map((v) => v.id)).toEqual(items.map((p) => p.id));
    expect(run.verdicts.every((v) => v.verdict === 'highlight')).toBe(true);
    expect(seen).toHaveLength(10); // onVerdict still fires once per passage
  });

  it('keeps verdicts in passage order when duplicates are interleaved with unique passages', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const jev = stubJev({ gate });
    const dup = 'A repeated block of boilerplate text that shows up more than once.';
    const items: Passage[] = [dup, 'a unique first passage of text', dup, 'a unique second passage of text', dup].map((text, index) => ({
      id: passageId(text),
      index,
      text,
    }));

    const running = new ReadingJudge(jev).judge(CTX, '', items);
    await settle();
    open();
    const run = await running;

    expect(jev.requests).toHaveLength(3); // three distinct ids
    expect(run.verdicts.map((v) => v.id)).toEqual(items.map((p) => p.id));
    expect(run.verdicts[0]).not.toBe(run.verdicts[2]); // a copy per passage, never one object shared
  });

  it('fails a whole duplicate group open from one call, counting an error per passage', async () => {
    let calls = 0;
    const hung: JevProvider = {
      name: 'hung',
      evaluate: () => {
        calls += 1;
        return new Promise<JevResponse>(() => {});
      },
    };
    const text = 'a passage repeated three times that never gets an answer at all';
    const items: Passage[] = Array.from({ length: 3 }, (_, index) => ({ id: passageId(text), index, text }));

    const run = await new ReadingJudge(hung, { timeoutMs: 10 }).judge(CTX, '', items);

    expect(calls).toBe(1);
    expect(run.errors).toBe(3); // errors are passage-shaped, as the panel's "N errors" line reads them
    expect(run.verdicts.map((v) => v.error)).toEqual([true, true, true]);
  });

  it('works against the mock provider, honouring fixtures keyed by passage id', async () => {
    const items = passages('a passage the fixture pins to a high core probability');
    const jev = createMockJev({ fixtures: { [items[0].id]: { core: 0.95 } } });

    const run = await new ReadingJudge(jev).judge(CTX, '', items);

    expect(run.verdicts[0].verdict).toBe('highlight');
    expect(run.verdicts[0].core).toBe(0.95);
    expect(run.usageTokens).toBe(0); // the mock reports no usage
  });
});
