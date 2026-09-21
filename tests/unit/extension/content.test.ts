// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { xAdapter } from '../../../src/extension/adapters/x';
import type { Item, Verdict } from '../../../src/core/types';
import { boot, startContentScript } from '../../../src/extension/content';
import type { Request, Response, send } from '../../../src/extension/messages';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string, search = ''): { doc: Document; loc: Location } {
  const html = readFileSync(path.join(FIXTURES, name), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const loc = { href: `http://localhost/${name}${search}` } as Location;
  return { doc, loc };
}

// The 2 crypto shills and the ragebait tweet fold; everything else keeps — mirrors how DuoAgent would
// decide this fixture under intent "Hide crypto shilling and ragebait."
const FOLD_IDS = new Set(['x:1700000000000000001', 'x:1700000000000000002', 'x:1700000000000000003']);

function fixtureVerdict(item: Item): Verdict {
  const decision = FOLD_IDS.has(item.id)
    ? { kind: 'fold' as const, ruleId: 'crypto', label: 'Crypto/ragebait', p: 0.92 }
    : { kind: 'keep' as const };
  return { itemId: item.id, rules: [], keeps: [], decision, latencyMs: 1, source: 'jev' };
}

function makeFakeSend(onCall?: (req: Request) => void) {
  return vi.fn(async (req: Request): Promise<Response> => {
    onCall?.(req);
    if (req.type === 'judge') return { ok: true, type: 'judge', verdicts: req.items.map(fixtureVerdict) };
    return { ok: false, error: 'unsupported in fake send' };
  });
}

// `send` is generic (`<R extends Request>(req: R) => Promise<Extract<Response, {type: R['type']}> | ...>`);
// a `vi.fn` mock's concrete `(req: Request) => Promise<Response>` signature is not structurally
// assignable to that (even though it behaves identically at runtime), so this one cast — applied at the
// single point every test hands its fake to startContentScript/boot — stands in for the real `send`.
function asSend(fn: (req: Request) => Promise<Response>): typeof send {
  return fn as unknown as typeof send;
}

function runContentScript(doc: Document, loc: Location, sendFake: (req: Request) => Promise<Response>, opts: { debounceMs?: number; maxBatch?: number } = {}) {
  return startContentScript(doc, loc, { send: asSend(sendFake), ...opts });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startContentScript', () => {
  it('is a no-op when the URL matches no adapter (never calls send)', () => {
    const { doc } = loadDoc('x.html');
    const send = makeFakeSend();
    const script = runContentScript(doc, { href: 'https://example.com/' } as Location, send);
    expect(script.seen()).toBe(0);
    script.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it('batches every post found on the initial scan into a single judge call and mounts the expected folds', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);

    expect(script.seen()).toBe(6);
    await new Promise((r) => setTimeout(r, 200));

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    expect(judgeCalls).toHaveLength(1);
    if (judgeCalls[0].type === 'judge') expect(judgeCalls[0].items).toHaveLength(6);

    expect(doc.querySelectorAll('.jd-bar')).toHaveLength(3);
    expect(doc.querySelectorAll('[data-jd="pending"]')).toHaveLength(0);
    script.stop();
  });

  it('force-flushes at maxBatch (10): the first judge request carries exactly 10 items, a second carries the rest', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const template = doc.querySelector('article[data-testid="tweet"]')!;
    const primaryColumn = doc.querySelector('[data-testid="primaryColumn"]')!;
    // 6 fixture tweets + 5 clones (unique status ids) = 11 posts total.
    for (let i = 0; i < 5; i++) {
      const clone = template.cloneNode(true) as Element;
      clone.querySelector('a[href*="/status/"]')!.setAttribute('href', `/clone${i}/status/900000000000000${i}`);
      primaryColumn.appendChild(clone);
    }

    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);

    expect(script.seen()).toBe(11);
    await new Promise((r) => setTimeout(r, 200));

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    expect(judgeCalls).toHaveLength(2);
    if (judgeCalls[0].type === 'judge') expect(judgeCalls[0].items).toHaveLength(10);
    if (judgeCalls[1].type === 'judge') expect(judgeCalls[1].items).toHaveLength(1);
    script.stop();
  });

  it('judges a later-appended post after the mutation observer fires, in its own judge request, and mounts its decision', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));
    expect(script.seen()).toBe(6);

    const article = doc.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = [
      '<div data-testid="User-Name"><span>New</span><span tabindex="-1">@new_person</span></div>',
      '<a href="/new_person/status/1700000000000000007"><time datetime="2026-09-21T01:00:00Z">now</time></a>',
      '<div data-testid="tweetText">A brand new tweet that just streamed in.</div>',
    ].join('');
    doc.querySelector('[data-testid="primaryColumn"]')!.appendChild(article);

    await new Promise((r) => setTimeout(r, 200));
    expect(script.seen()).toBe(7);

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    expect(judgeCalls).toHaveLength(2);
    if (judgeCalls[1].type === 'judge') {
      expect(judgeCalls[1].items).toHaveLength(1);
      expect(judgeCalls[1].items[0].id).toBe('x:1700000000000000007');
    }
    // The appended tweet isn't in FOLD_IDS, so fixtureVerdict gives it a plain keep, which mounts a
    // hover-only hide-this button directly on the post element — proof a decision actually landed.
    expect(article.querySelector('.jd-hide')).toBeTruthy();
    script.stop();
  });

  it('caps re-extraction of a permanently null post at MAX_EXTRACT_ATTEMPTS (5) and never sends it for judging', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const broken = doc.createElement('article');
    broken.setAttribute('data-testid', 'tweet');
    broken.innerHTML = '<div data-testid="tweetPhoto"></div>'; // no tweetText: extract() always returns null
    doc.querySelector('[data-testid="primaryColumn"]')!.appendChild(broken);

    const extractSpy = vi.spyOn(xAdapter, 'extract');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);

    await new Promise((r) => setTimeout(r, 200)); // initial scan (attempt 1) + its debounce/flush

    // Six more mutation-triggered scans (attempts 2-5, then two that must be skipped by the cap).
    for (let i = 0; i < 6; i++) {
      doc.body.appendChild(doc.createComment(`scan-trigger-${i}`));
      await new Promise((r) => setTimeout(r, 40));
    }

    const brokenAttempts = extractSpy.mock.calls.filter(([el]) => el === broken).length;
    expect(brokenAttempts).toBe(5);
    expect(script.seen()).toBe(7); // 6 real tweets + the broken one, given up on and marked seen

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    expect(judgeCalls).toHaveLength(1); // only the initial batch of 6 real tweets; broken never queued
    if (judgeCalls[0].type === 'judge') expect(judgeCalls[0].items).toHaveLength(6);

    script.stop();
  });

  it('on ok:false clears pending and leaves posts visible without mounting anything', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = vi.fn(async (): Promise<Response> => ({ ok: false, error: 'boom' }));
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));

    expect(doc.querySelectorAll('[data-jd="pending"]')).toHaveLength(0);
    expect(doc.querySelectorAll('.jd-bar')).toHaveLength(0);
    expect(doc.querySelectorAll('.jd-folded')).toHaveLength(0);
    script.stop();
  });

  it('stop() disconnects the observer: later mutations are no longer judged', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeFakeSend();
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));
    script.stop();

    const article = doc.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = '<div data-testid="tweetText">post-stop tweet</div>';
    doc.querySelector('[data-testid="primaryColumn"]')!.appendChild(article);

    await new Promise((r) => setTimeout(r, 200));
    expect(script.seen()).toBe(6);
  });

  it('a broken adapter/DOM (findPosts throws) never touches the page and stays a no-op scan', () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeFakeSend();
    // Real adapters never throw on well-formed DOM, so this exercises scan()'s own try/catch by making
    // the document itself hostile: querySelectorAll throws on the first (synchronous, initial) scan.
    const original = doc.querySelectorAll.bind(doc);
    let thrown = false;
    doc.querySelectorAll = ((sel: string) => {
      if (!thrown) { thrown = true; throw new Error('boom'); }
      return original(sel);
    }) as typeof doc.querySelectorAll;

    const script = runContentScript(doc, loc, send);
    expect(script.seen()).toBe(0); // first scan threw and was swallowed; nothing marked seen
    script.stop();
  });

  it('onWrong sends feedback with expected:"show" and the original item', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));

    const wrongBtn = doc.querySelector<HTMLButtonElement>('.jd-wrong')!;
    wrongBtn.click();

    const feedback = calls.find((c) => c.type === 'feedback');
    expect(feedback).toBeTruthy();
    if (feedback?.type === 'feedback') {
      expect(feedback.example.expected).toBe('show');
      expect(feedback.example.source).toBe('user');
      expect(FOLD_IDS.has(feedback.example.item.id)).toBe(true);
    }
    script.stop();
  });

  it('onHideThis (from a plain keep) sends feedback with expected:"hide"', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));

    const hideBtn = doc.querySelector<HTMLButtonElement>('.jd-hide');
    expect(hideBtn).toBeTruthy();
    hideBtn!.click();

    const feedback = calls.find((c) => c.type === 'feedback');
    expect(feedback).toBeTruthy();
    if (feedback?.type === 'feedback') expect(feedback.example.expected).toBe('hide');
    script.stop();
  });
});

describe('boot', () => {
  function makeGetStateSend(enabledSites: Record<'x' | 'reddit' | 'hn', boolean> | null) {
    return vi.fn(async (req: Request): Promise<Response> => {
      if (req.type !== 'getState') return { ok: false, error: 'unexpected request in boot test' };
      if (enabledSites === null) return { ok: false, error: 'boom' };
      return {
        ok: true,
        type: 'getState',
        settings: { providerMode: 'mock', keys: {}, intent: '', strictness: 0.5, arbiter: true, enabledSites },
        stats: { judged: 0, folded: 0, dimmed: 0, badged: 0, kept: 0, keptByRule: 0, errors: 0, cacheHits: 0, arbitrated: 0, p50LatencyMs: 0, estimatedUsd: 0, inputTokens: 0, lastSources: [] },
        exampleCount: 0,
        hasKeys: false,
        providers: { jev: 'mock', llm: 'mock' },
      };
    });
  }

  it('does not call start when getState reports the platform disabled', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeGetStateSend({ x: false, reddit: true, hn: true });
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).not.toHaveBeenCalled();
  });

  it('does not call start when getState fails (fail open by staying inert)', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeGetStateSend(null);
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).not.toHaveBeenCalled();
  });

  it('calls start exactly once, with the page, when the platform is enabled', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeGetStateSend({ x: true, reddit: true, hn: true });
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(doc, loc, { send: asSend(send) });
  });

  it('is a no-op (never calls getState or start) when the URL matches no adapter', async () => {
    const { doc } = loadDoc('x.html');
    const send = makeGetStateSend({ x: true, reddit: true, hn: true });
    const start = vi.fn();
    await boot({ doc, loc: { href: 'https://example.com/' } as Location, send: asSend(send), start });
    expect(send).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
