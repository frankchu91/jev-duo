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

function runContentScript(doc: Document, loc: Location, sendFake: (req: Request) => Promise<Response>, opts: { debounceMs?: number; maxBatch?: number; seenReportMs?: number } = {}) {
  return startContentScript(doc, loc, { send: asSend(sendFake), ...opts });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startContentScript', () => {
  // genericAdapter is now a universal fallback (spec §3: `matches` is unconditionally true), so
  // startContentScript itself has no "no adapter matched" no-op left to test — that gate lives entirely
  // in boot()/isSiteEnabled (see the `boot` describe block below). This proves the generic adapter
  // drives the same scan pipeline as the built-ins once actually started.
  it('runs the generic adapter (no gate of its own) on a URL no built-in adapter matches', () => {
    const { doc, loc } = loadDoc('generic.html');
    const send = makeFakeSend();
    const script = runContentScript(doc, loc, send);
    expect(script.seen()).toBe(6);
    script.stop();
    expect(send).toHaveBeenCalled();
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
    // Every queued post carries the id its adapter derived, so a judged item can be found in the DOM
    // (the e2e reads these to key its fixture probabilities off the real ids).
    expect([...doc.querySelectorAll('[data-jd-id]')].map((el) => el.getAttribute('data-jd-id'))).toEqual([
      'x:1700000000000000001',
      'x:1700000000000000002',
      'x:1700000000000000003',
      'x:1700000000000000004',
      'x:1700000000000000005',
      'x:1700000000000000006',
    ]);
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

  // Spec §8: an adapter whose selectors have gone stale finds nothing, and the popup has to be able to
  // say so. The count is reported per page, not inferred from the judge traffic (which is empty in
  // exactly that case).
  it('reports the initial post count to the background as pageSeen', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);

    expect(calls.filter((c) => c.type === 'pageSeen')).toEqual([{ type: 'pageSeen', platform: 'x', seen: 6 }]);
    script.stop();
  });

  it('reports seen:0 on a page whose posts the adapter cannot find at all', async () => {
    const { loc } = loadDoc('x.html', '?jd-platform=x');
    const doc = new DOMParser().parseFromString('<html><body><div>not a feed</div></body></html>', 'text/html');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);

    expect(calls.filter((c) => c.type === 'pageSeen')).toEqual([{ type: 'pageSeen', platform: 'x', seen: 0 }]);
    script.stop();
  });

  it('re-reports (debounced) only when a later scan changes the count', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send, { seenReportMs: 20 });
    expect(calls.filter((c) => c.type === 'pageSeen')).toHaveLength(1);

    doc.body.appendChild(doc.createComment('a mutation that adds no posts'));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((c) => c.type === 'pageSeen')).toHaveLength(1); // count unchanged: no second report

    const article = doc.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    article.innerHTML = [
      '<a href="/new_person/status/1700000000000000009"><time datetime="2026-09-21T01:00:00Z">now</time></a>',
      '<div data-testid="tweetText">One more tweet streamed in.</div>',
    ].join('');
    doc.querySelector('[data-testid="primaryColumn"]')!.appendChild(article);
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.filter((c) => c.type === 'pageSeen')).toEqual([
      { type: 'pageSeen', platform: 'x', seen: 6 },
      { type: 'pageSeen', platform: 'x', seen: 7 },
    ]);
    script.stop();
  });

  // The background's map of reports is per service worker, and Chrome restarts that worker freely
  // (and empties the map on an extension reload), so a page whose count never changes — a broken
  // adapter stuck at 0 above all — has to keep saying so rather than report once and go quiet.
  it('re-states the same count every 30s, and stops doing it after stop()', async () => {
    vi.useFakeTimers();
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);
    const reports = () => calls.filter((c) => c.type === 'pageSeen');
    expect(reports()).toHaveLength(1); // the initial one

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reports()).toHaveLength(3);
    expect(reports()).toEqual(Array.from({ length: 3 }, () => ({ type: 'pageSeen', platform: 'x', seen: 6 })));

    script.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reports()).toHaveLength(3); // the interval is cleared with everything else
  });

  // Two elements can carry the same item id (a quoted or reposted tweet renders twice). The first copy
  // must still get its verdict; the duplicate is skipped rather than overwriting it and stranding it.
  it('a duplicate item id never leaves the first copy stuck in the pending state', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const first = doc.querySelector('article[data-testid="tweet"]')!;
    const clone = first.cloneNode(true) as Element; // same status id => same item id
    doc.querySelector('[data-testid="primaryColumn"]')!.appendChild(clone);

    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = runContentScript(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    if (judgeCalls[0].type === 'judge') expect(judgeCalls[0].items.map((i) => i.id)).toHaveLength(6); // the duplicate is not queued twice
    expect(doc.querySelectorAll('[data-jd="pending"]')).toHaveLength(0);
    expect(doc.querySelectorAll('.jd-bar')).toHaveLength(3); // ...and the first copy still got folded
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
  /** `enabled: null` makes the request fail. Anything other than `isSiteEnabled` is rejected, which
   * is what pins the contract: boot must never ask for `getState` (that response carries the user's
   * raw API keys, and this code runs in the page's world). */
  function makeIsSiteEnabledSend(enabled: boolean | null) {
    return vi.fn(async (req: Request): Promise<Response> => {
      if (req.type !== 'isSiteEnabled') return { ok: false, error: `unexpected ${req.type} request in boot` };
      if (enabled === null) return { ok: false, error: 'boom' };
      return { ok: true, type: 'isSiteEnabled', enabled };
    });
  }

  it('asks isSiteEnabled (never getState) for the picked adapter\'s platform', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeIsSiteEnabledSend(true);
    await boot({ doc, loc, send: asSend(send), start: vi.fn() });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'isSiteEnabled', platform: 'x' });
  });

  // Spec §4: the generic adapter is gated per origin, so boot must forward `location.origin` — the
  // built-in platforms above never rely on it (their `loc` fakes omit `.origin` entirely).
  it('sends the page origin along with the platform, for a generic (non-built-in) site', async () => {
    const { doc } = loadDoc('x.html');
    const loc = { href: 'https://mastodon.social/home', origin: 'https://mastodon.social' } as Location;
    const send = makeIsSiteEnabledSend(true);
    await boot({ doc, loc, send: asSend(send), start: vi.fn() });
    expect(send).toHaveBeenCalledWith({ type: 'isSiteEnabled', platform: 'generic', origin: 'https://mastodon.social' });
  });

  it('does not call start when the platform is disabled', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeIsSiteEnabledSend(false);
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).not.toHaveBeenCalled();
  });

  it('does not call start when the request fails (fail open by staying inert)', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeIsSiteEnabledSend(null);
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).not.toHaveBeenCalled();
  });

  it('calls start exactly once, with the page, when the platform is enabled', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeIsSiteEnabledSend(true);
    const start = vi.fn();
    await boot({ doc, loc, send: asSend(send), start });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(doc, loc, { send: asSend(send) });
  });

  // genericAdapter is now a universal fallback (spec §3), so an unrecognized URL is no longer
  // special-cased to skip the ask entirely — it goes through the exact same isSiteEnabled gate as any
  // built-in platform, just as platform:'generic', and stays inert precisely when that gate says no.
  it('still asks isSiteEnabled (as platform generic) for a URL no built-in adapter matches, and stays inert when disabled', async () => {
    const { doc } = loadDoc('x.html');
    const send = makeIsSiteEnabledSend(false);
    const start = vi.fn();
    await boot({ doc, loc: { href: 'https://example.com/' } as Location, send: asSend(send), start });
    expect(send).toHaveBeenCalledWith({ type: 'isSiteEnabled', platform: 'generic', origin: undefined });
    expect(start).not.toHaveBeenCalled();
  });
});
