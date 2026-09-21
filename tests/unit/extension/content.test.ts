// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Item, Verdict } from '../../../src/core/types';
import { startContentScript } from '../../../src/extension/content';
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
// single point every test hands its fake to `startContentScript` — stands in for the real `send`.
function start(doc: Document, loc: Location, sendFake: (req: Request) => Promise<Response>, opts: { debounceMs?: number; maxBatch?: number } = {}) {
  return startContentScript(doc, loc, { send: sendFake as unknown as typeof send, ...opts });
}

describe('startContentScript', () => {
  it('is a no-op when the URL matches no adapter (never calls send)', () => {
    const { doc } = loadDoc('x.html');
    const send = makeFakeSend();
    const script = start(doc, { href: 'https://example.com/' } as Location, send);
    expect(script.seen()).toBe(0);
    script.stop();
    expect(send).not.toHaveBeenCalled();
  });

  it('batches every post found on the initial scan into a single judge call and mounts the expected folds', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = start(doc, loc, send);

    expect(script.seen()).toBe(6);
    await new Promise((r) => setTimeout(r, 200));

    const judgeCalls = calls.filter((c) => c.type === 'judge');
    expect(judgeCalls).toHaveLength(1);
    if (judgeCalls[0].type === 'judge') expect(judgeCalls[0].items).toHaveLength(6);

    expect(doc.querySelectorAll('.jd-bar')).toHaveLength(3);
    expect(doc.querySelectorAll('[data-jd="pending"]')).toHaveLength(0);
    script.stop();
  });

  it('judges a later-appended post after the mutation observer fires', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeFakeSend();
    const script = start(doc, loc, send);
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
    script.stop();
  });

  it('on ok:false clears pending and leaves posts visible without mounting anything', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = vi.fn(async (): Promise<Response> => ({ ok: false, error: 'boom' }));
    const script = start(doc, loc, send);
    await new Promise((r) => setTimeout(r, 200));

    expect(doc.querySelectorAll('[data-jd="pending"]')).toHaveLength(0);
    expect(doc.querySelectorAll('.jd-bar')).toHaveLength(0);
    expect(doc.querySelectorAll('.jd-folded')).toHaveLength(0);
    script.stop();
  });

  it('stop() disconnects the observer: later mutations are no longer judged', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const send = makeFakeSend();
    const script = start(doc, loc, send);
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

    const script = start(doc, loc, send);
    expect(script.seen()).toBe(0); // first scan threw and was swallowed; nothing marked seen
    script.stop();
  });

  it('onWrong sends feedback with expected:"show" and the original item', async () => {
    const { doc, loc } = loadDoc('x.html', '?jd-platform=x');
    const calls: Request[] = [];
    const send = makeFakeSend((req) => calls.push(req));
    const script = start(doc, loc, send);
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
    const script = start(doc, loc, send);
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
