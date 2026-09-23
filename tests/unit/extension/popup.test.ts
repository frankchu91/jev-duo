// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuoStats } from '../../../src/core/duo';
import type { QuestionPack } from '../../../src/core/types';
import type { PageSeenReport, Request, Response, Settings, send } from '../../../src/extension/messages';
import { initPopup } from '../../../src/extension/popup/popup';
import { EXTENSION_ORIGIN, installChromeStub, type ChromeStub } from './chrome-stub';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.resolve(__dirname, '../../../src/extension/popup/popup.html'), 'utf8');

function loadDoc(): Document {
  return new DOMParser().parseFromString(HTML, 'text/html');
}

function el<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`test: missing #${id}`);
  return found as T;
}

/** Flushes the microtask queue (a promise chain of any depth) via a macrotask boundary — robust
 * regardless of how many `.then()` hops sit between a click and the DOM update it triggers. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** An externally-resolvable promise, for tests that need to observe popup.ts's state (button disabled,
 * status text) *while* a `send` call is still in flight, before choosing how it resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const PACK: QuestionPack = {
  version: 1,
  intent: 'Hide crypto shilling.',
  compiledAt: '2026-01-01T00:00:00.000Z',
  compiledBy: 'mock',
  rules: [{ id: 'r_crypto', label: 'Crypto shilling', question: 'Is this promoting a cryptocurrency or NFT?', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] }],
  keeps: [{ id: 'k_friend', label: 'Close friend', question: 'Is this from someone I follow closely?', threshold: 0.6 }],
};

const RECOMPILED_PACK: QuestionPack = {
  ...PACK,
  compiledAt: '2026-01-02T00:00:00.000Z',
  rules: [...PACK.rules, { id: 'r_rage', label: 'Ragebait', question: 'Is this outrage bait?', threshold: 0.75, action: 'dim', ambiguous: [0.5, 0.75] }],
};

const SETTINGS: Settings = {
  providerMode: 'mock',
  keys: {},
  intent: 'Hide crypto shilling.',
  pack: PACK,
  strictness: 0.5,
  arbiter: true,
  focus: '',
  enabledSites: { x: true, reddit: true, hn: true },
  genericSites: [],
};

const STATS: DuoStats = {
  judged: 12,
  folded: 3,
  dimmed: 1,
  badged: 0,
  kept: 8,
  keptByRule: 2,
  errors: 1,
  cacheHits: 4,
  arbitrated: 0,
  p50LatencyMs: 42,
  estimatedUsd: 0.000731,
  inputTokens: 500,
  lastSources: ['jev', 'jev', 'cache'],
};

function getStateResponse(overrides: Partial<Settings> = {}, stats: DuoStats = STATS, exampleCount = 4, pageSeen: PageSeenReport[] = []): Response {
  return {
    ok: true,
    type: 'getState',
    settings: { ...SETTINGS, ...overrides, keys: { ...SETTINGS.keys, ...overrides.keys }, enabledSites: { ...SETTINGS.enabledSites, ...overrides.enabledSites } },
    stats,
    exampleCount,
    hasKeys: false,
    providers: { jev: 'mock', llm: 'mock' },
    pageSeen,
  };
}

const report = (tabId: number, seen: number, platform: PageSeenReport['platform'] = 'x'): PageSeenReport => ({
  tabId,
  platform,
  seen,
  at: '2026-01-01T00:00:00.000Z',
});

function makeFakeSend(impl: (req: Request) => Response) {
  return vi.fn(async (req: Request): Promise<Response> => impl(req));
}

// `send` is generic (`<R extends Request>(req: R) => Promise<Extract<Response,{type:R['type']}> | ...>`);
// a `vi.fn` mock's concrete `(req: Request) => Promise<Response>` signature isn't structurally
// assignable to that (same note as tests/unit/extension/content.test.ts) — this one cast stands in for
// the real `send` at the single point every test hands its fake to `initPopup`.
function asSend(fn: (req: Request) => Promise<Response>): typeof send {
  return fn as unknown as typeof send;
}

describe('initPopup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on init, getState fills the intent, strictness, provider, checkboxes, brain status and stats', async () => {
    const doc = loadDoc();
    const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse() : { ok: false, error: 'unhandled' }));
    await initPopup(doc, { send: asSend(send) });

    expect(el<HTMLTextAreaElement>(doc, 'intent').value).toBe(SETTINGS.intent);
    expect(el<HTMLInputElement>(doc, 'strictness').value).toBe('0.5');
    expect(el(doc, 'strictness-value').textContent).toBe('50%');
    expect(el<HTMLSelectElement>(doc, 'provider').value).toBe('mock');
    expect(el<HTMLInputElement>(doc, 'arbiter').checked).toBe(true);
    expect(el<HTMLInputElement>(doc, 'site-x').checked).toBe(true);
    expect(el<HTMLInputElement>(doc, 'site-reddit').checked).toBe(true);
    expect(el<HTMLInputElement>(doc, 'site-hn').checked).toBe(true);
    expect(el(doc, 'brain-status').textContent).toBe('fast brain: mock · slow brain: mock');
    expect(el(doc, 'stats').textContent).toBe('judged 12 · folded 3 · kept 8 · errors 1 · p50 42ms · ~$0.0007');
    expect(el(doc, 'examples').textContent).toBe('4 corrections');

    doc.dispatchEvent(new Event('unload'));
  });

  it('renders one <li> per rule and keep from settings.pack', async () => {
    const doc = loadDoc();
    const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse() : { ok: false, error: 'unhandled' }));
    await initPopup(doc, { send: asSend(send) });

    const items = doc.querySelectorAll('#rules li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('⚡ Crypto shilling · Is this promoting a cryptocurrency or NFT? · 70%');
    expect(items[1]?.textContent).toBe('★ Close friend · Is this from someone I follow closely? · 60%');

    doc.dispatchEvent(new Event('unload'));
  });

  it('Compile click sends {type:"compile", intent} and renders the returned pack', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse({ pack: undefined });
      if (req.type === 'compile') return { ok: true, type: 'compile', pack: { ...RECOMPILED_PACK, intent: req.intent } };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });
    expect(doc.querySelectorAll('#rules li')).toHaveLength(0);

    el<HTMLTextAreaElement>(doc, 'intent').value = 'Hide crypto shilling and ragebait.';
    el<HTMLButtonElement>(doc, 'compile').click();
    await flush();

    const compileCalls = calls.filter((c) => c.type === 'compile');
    expect(compileCalls).toHaveLength(1);
    if (compileCalls[0]?.type === 'compile') expect(compileCalls[0].intent).toBe('Hide crypto shilling and ragebait.');

    expect(doc.querySelectorAll('#rules li')).toHaveLength(3);
    expect(el(doc, 'compile-status').textContent).toBe('compiled 2 rules, 1 keeps');
    expect(el(doc, 'compile-status').classList.contains('error')).toBe(false);

    doc.dispatchEvent(new Event('unload'));
  });

  it('an ok:false compile response shows the error in #compile-status and leaves rules untouched', async () => {
    const doc = loadDoc();
    const send = makeFakeSend((req) => {
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'compile') return { ok: false, error: 'llm provider unavailable' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    el<HTMLButtonElement>(doc, 'compile').click();
    await flush();

    expect(el(doc, 'compile-status').textContent).toBe('llm provider unavailable');
    expect(el(doc, 'compile-status').classList.contains('error')).toBe(true);
    expect(doc.querySelectorAll('#rules li')).toHaveLength(2); // unchanged from init

    doc.dispatchEvent(new Event('unload'));
  });

  it('changing strictness (change event) sends setSettings with the number and updates the live value', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'setSettings') return { ok: true, type: 'setSettings' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const strictness = el<HTMLInputElement>(doc, 'strictness');
    strictness.value = '0.8';
    strictness.dispatchEvent(new Event('change'));
    await flush();

    const setCalls = calls.filter((c) => c.type === 'setSettings');
    expect(setCalls).toHaveLength(1);
    if (setCalls[0]?.type === 'setSettings') expect(setCalls[0].patch).toEqual({ strictness: 0.8 });
    expect(el(doc, 'strictness-value').textContent).toBe('80%');

    doc.dispatchEvent(new Event('unload'));
  });

  it('selecting openrouter shows only the openrouter key field', async () => {
    const doc = loadDoc();
    const send = makeFakeSend((req) => {
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'setSettings') return { ok: true, type: 'setSettings' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    expect(el(doc, 'field-openrouter').hidden).toBe(true); // starts hidden: default mode is mock
    expect(el(doc, 'field-typesafe').hidden).toBe(true);
    expect(el(doc, 'field-anthropic').hidden).toBe(true);

    const provider = el<HTMLSelectElement>(doc, 'provider');
    provider.value = 'openrouter';
    provider.dispatchEvent(new Event('change'));

    expect(el(doc, 'field-openrouter').hidden).toBe(false);
    expect(el(doc, 'field-typesafe').hidden).toBe(true);
    expect(el(doc, 'field-anthropic').hidden).toBe(true);

    doc.dispatchEvent(new Event('unload'));
  });

  it('key inputs save on change immediately, with no debounce', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse({ providerMode: 'openrouter' });
      if (req.type === 'setSettings') return { ok: true, type: 'setSettings' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const key = el<HTMLInputElement>(doc, 'key-openrouter');
    key.value = 'sk-or-abc123';
    key.dispatchEvent(new Event('change'));

    const setCalls = calls.filter((c) => c.type === 'setSettings');
    expect(setCalls).toHaveLength(1); // no debounce/timer needed: the call is already recorded
    if (setCalls[0]?.type === 'setSettings') expect(setCalls[0].patch).toEqual({ keys: { openrouter: 'sk-or-abc123' } });

    doc.dispatchEvent(new Event('unload'));
  });

  it('text inputs (intent, llm-model) are debounced 300ms and coalesce rapid keystrokes', async () => {
    vi.useFakeTimers();
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'setSettings') return { ok: true, type: 'setSettings' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const intent = el<HTMLTextAreaElement>(doc, 'intent');
    intent.value = 'Hide crypto shilling and ragebait.';
    intent.dispatchEvent(new Event('input'));
    intent.value = 'Hide crypto shilling and ragebait now.';
    intent.dispatchEvent(new Event('input')); // a second keystroke within the window resets the debounce

    expect(calls.filter((c) => c.type === 'setSettings')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(299);
    expect(calls.filter((c) => c.type === 'setSettings')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const setCalls = calls.filter((c) => c.type === 'setSettings');
    expect(setCalls).toHaveLength(1); // the two keystrokes coalesce into a single call
    if (setCalls[0]?.type === 'setSettings') expect(setCalls[0].patch).toEqual({ intent: 'Hide crypto shilling and ragebait now.' });

    doc.dispatchEvent(new Event('unload'));
  });

  it('checkbox changes send setSettings with the right patch shape (arbiter, sites)', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'setSettings') return { ok: true, type: 'setSettings' };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    el<HTMLInputElement>(doc, 'arbiter').checked = false;
    el<HTMLInputElement>(doc, 'arbiter').dispatchEvent(new Event('change'));
    el<HTMLInputElement>(doc, 'site-reddit').checked = false;
    el<HTMLInputElement>(doc, 'site-reddit').dispatchEvent(new Event('change'));

    const patches = calls.filter((c) => c.type === 'setSettings').map((c) => (c.type === 'setSettings' ? c.patch : undefined));
    expect(patches).toContainEqual({ arbiter: false });
    // enabledSites is a full Record<SiteId,boolean>, so a single checkbox change sends the whole triple.
    expect(patches).toContainEqual({ enabledSites: { x: true, reddit: false, hn: true } });

    doc.dispatchEvent(new Event('unload'));
  });

  it('Recompile button sends {type:"recompile"} and re-renders rules from the response', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'recompile') return { ok: true, type: 'recompile', pack: RECOMPILED_PACK };
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    el<HTMLButtonElement>(doc, 'recompile').click();
    await flush();

    expect(calls.some((c) => c.type === 'recompile')).toBe(true);
    expect(doc.querySelectorAll('#rules li')).toHaveLength(3);
    expect(el(doc, 'compile-status').textContent).toBe('recompiled 2 rules, 1 keeps');

    doc.dispatchEvent(new Event('unload'));
  });

  it('Reset button sends {type:"resetStats"} and refreshes the stats line', async () => {
    const doc = loadDoc();
    const zeroed: DuoStats = { ...STATS, judged: 0, folded: 0, kept: 0, errors: 0, p50LatencyMs: 0, estimatedUsd: 0 };
    let getStateCalls = 0;
    const calls: Request[] = [];
    const send = makeFakeSend((req) => {
      calls.push(req);
      if (req.type === 'getState') {
        getStateCalls += 1;
        return getStateResponse({}, getStateCalls === 1 ? STATS : zeroed);
      }
      if (req.type === 'resetStats') return { ok: true, type: 'resetStats' };
      return { ok: false, error: 'unhandled' };
    });

    await initPopup(doc, { send: asSend(send) });
    expect(el(doc, 'stats').textContent).toContain('judged 12');

    el<HTMLButtonElement>(doc, 'reset-stats').click();
    await flush();

    expect(calls.some((c) => c.type === 'resetStats')).toBe(true);
    expect(el(doc, 'stats').textContent).toContain('judged 0');

    doc.dispatchEvent(new Event('unload'));
  });

  it('refreshes stats every 2s while open, and the timer is cleared once the popup unloads', async () => {
    vi.useFakeTimers();
    const doc = loadDoc();
    let getStateCalls = 0;
    const send = makeFakeSend((req) => {
      if (req.type === 'getState') {
        getStateCalls += 1;
        return getStateResponse();
      }
      return { ok: false, error: 'unhandled' };
    });

    await initPopup(doc, { send: asSend(send) });
    expect(getStateCalls).toBe(1); // the initial fill

    await vi.advanceTimersByTimeAsync(2000);
    expect(getStateCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(getStateCalls).toBe(3);

    doc.dispatchEvent(new Event('unload'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(getStateCalls).toBe(3); // no further calls after unload: the interval was cleared
  });

  // --- Spec §8: "0 posts seen on this page" (the pageSeen report for the popup's own tab) ---

  describe('#page-seen', () => {
    /** Installs the chrome stub with `tabs.query` answering with `tabId` as the active tab, which is
     * how the popup picks its own tab's report out of getState. */
    function withActiveTab(tabId: number): void {
      installChromeStub().setTabs([{ id: tabId }]);
    }

    afterEach(() => {
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it('shows the count for the popup\'s own tab, ignoring other tabs\' reports', async () => {
      withActiveTab(7);
      const doc = loadDoc();
      const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({}, STATS, 4, [report(3, 42, 'reddit'), report(7, 6)]) : { ok: false, error: 'unhandled' }));
      await initPopup(doc, { send: asSend(send) });

      expect(el(doc, 'page-seen').textContent).toBe('6 posts seen on x');
      doc.dispatchEvent(new Event('unload'));
    });

    // Fix wave, minor: `generic` is the adapter's name, not a site the user would recognise, so the
    // one platform with no site name of its own says "this site" instead.
    it('says "this site" rather than "generic" for a generic-adapter report', async () => {
      withActiveTab(7);
      const doc = loadDoc();
      const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({}, STATS, 4, [report(7, 6, 'generic')]) : { ok: false, error: 'unhandled' }));
      await initPopup(doc, { send: asSend(send) });

      expect(el(doc, 'page-seen').textContent).toBe('6 posts seen on this site');
      doc.dispatchEvent(new Event('unload'));
    });

    it('spells out a zero count as a possible layout change', async () => {
      withActiveTab(7);
      const doc = loadDoc();
      const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({}, STATS, 4, [report(7, 0, 'hn')]) : { ok: false, error: 'unhandled' }));
      await initPopup(doc, { send: asSend(send) });

      expect(el(doc, 'page-seen').textContent).toBe("0 posts seen on this page — the site's layout may have changed");
      expect(el(doc, 'page-seen').classList.contains('error')).toBe(true);
      doc.dispatchEvent(new Event('unload'));
    });

    it('says so when this tab has not reported (no content script running there)', async () => {
      withActiveTab(9);
      const doc = loadDoc();
      const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({}, STATS, 4, [report(7, 6)]) : { ok: false, error: 'unhandled' }));
      await initPopup(doc, { send: asSend(send) });

      expect(el(doc, 'page-seen').textContent).toBe('no page report yet');
      doc.dispatchEvent(new Event('unload'));
    });

    it('updates on the next refresh tick when the page starts producing posts', async () => {
      withActiveTab(7);
      vi.useFakeTimers();
      const doc = loadDoc();
      let calls = 0;
      const send = makeFakeSend((req) => {
        if (req.type !== 'getState') return { ok: false, error: 'unhandled' };
        calls += 1;
        return getStateResponse({}, STATS, 4, [report(7, calls === 1 ? 0 : 12)]);
      });
      await initPopup(doc, { send: asSend(send) });
      expect(el(doc, 'page-seen').textContent).toContain('0 posts seen');

      await vi.advanceTimersByTimeAsync(2000);
      expect(el(doc, 'page-seen').textContent).toBe('12 posts seen on x');
      expect(el(doc, 'page-seen').classList.contains('error')).toBe(false);

      doc.dispatchEvent(new Event('unload'));
    });
  });

  // --- Fix round 1: submit re-entrancy guard (Compile/Recompile/Reset) ---

  it('Compile is guarded against double-click, disables Recompile too while pending, and re-enables after resolving ok:true', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const pending = deferred<Response>();
    const send = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse({ pack: undefined });
      if (req.type === 'compile') return pending.promise;
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const compileBtn = el<HTMLButtonElement>(doc, 'compile');
    const recompileBtn = el<HTMLButtonElement>(doc, 'recompile');

    compileBtn.click();
    compileBtn.click(); // a second click while the first is still in flight must be a no-op

    expect(calls.filter((c) => c.type === 'compile')).toHaveLength(1);
    expect(compileBtn.disabled).toBe(true);
    expect(recompileBtn.disabled).toBe(true); // mutual exclusion while a compile is pending
    expect(el(doc, 'compile-status').textContent).toBe('compiling…');

    pending.resolve({ ok: true, type: 'compile', pack: RECOMPILED_PACK });
    await flush();

    expect(compileBtn.disabled).toBe(false);
    expect(recompileBtn.disabled).toBe(false);
    expect(el(doc, 'compile-status').textContent).toBe('compiled 2 rules, 1 keeps');

    doc.dispatchEvent(new Event('unload'));
  });

  it('Compile re-enables both buttons after resolving ok:false, and shows the error', async () => {
    const doc = loadDoc();
    const pending = deferred<Response>();
    const send = vi.fn(async (req: Request): Promise<Response> => {
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'compile') return pending.promise;
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const compileBtn = el<HTMLButtonElement>(doc, 'compile');
    const recompileBtn = el<HTMLButtonElement>(doc, 'recompile');
    compileBtn.click();
    expect(compileBtn.disabled).toBe(true);
    expect(recompileBtn.disabled).toBe(true);

    pending.resolve({ ok: false, error: 'llm provider unavailable' });
    await flush();

    expect(compileBtn.disabled).toBe(false);
    expect(recompileBtn.disabled).toBe(false);
    expect(el(doc, 'compile-status').textContent).toBe('llm provider unavailable');
    expect(el(doc, 'compile-status').classList.contains('error')).toBe(true);

    doc.dispatchEvent(new Event('unload'));
  });

  it('Recompile likewise disables Compile while pending (the reverse direction), and both re-enable after', async () => {
    const doc = loadDoc();
    const pending = deferred<Response>();
    const send = vi.fn(async (req: Request): Promise<Response> => {
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'recompile') return pending.promise;
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const compileBtn = el<HTMLButtonElement>(doc, 'compile');
    const recompileBtn = el<HTMLButtonElement>(doc, 'recompile');
    recompileBtn.click();

    expect(recompileBtn.disabled).toBe(true);
    expect(compileBtn.disabled).toBe(true);
    expect(el(doc, 'compile-status').textContent).toBe('recompiling…');

    pending.resolve({ ok: true, type: 'recompile', pack: RECOMPILED_PACK });
    await flush();

    expect(recompileBtn.disabled).toBe(false);
    expect(compileBtn.disabled).toBe(false);
    expect(el(doc, 'compile-status').textContent).toBe('recompiled 2 rules, 1 keeps');

    doc.dispatchEvent(new Event('unload'));
  });

  it('Reset is guarded against double-click while its own request is pending', async () => {
    const doc = loadDoc();
    const calls: Request[] = [];
    const pending = deferred<Response>();
    const send = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(req);
      if (req.type === 'getState') return getStateResponse();
      if (req.type === 'resetStats') return pending.promise;
      return { ok: false, error: 'unhandled' };
    });
    await initPopup(doc, { send: asSend(send) });

    const resetBtn = el<HTMLButtonElement>(doc, 'reset-stats');
    resetBtn.click();
    resetBtn.click(); // second click while pending: no-op

    expect(calls.filter((c) => c.type === 'resetStats')).toHaveLength(1);
    expect(resetBtn.disabled).toBe(true);

    pending.resolve({ ok: true, type: 'resetStats' });
    await flush();

    expect(resetBtn.disabled).toBe(false);

    doc.dispatchEvent(new Event('unload'));
  });

  // --- Fix round 1: visible, self-recovering error when the initial getState fails ---

  it('shows a visible error when the initial getState fails, and leaves every control usable', async () => {
    const doc = loadDoc();
    const send = makeFakeSend((req) => (req.type === 'getState' ? { ok: false, error: 'boom' } : { ok: false, error: 'unhandled' }));
    await initPopup(doc, { send: asSend(send) });

    const status = el(doc, 'compile-status').textContent ?? '';
    expect(status).toContain('boom');
    expect(status).toContain('reopen the popup');
    expect(el(doc, 'compile-status').classList.contains('error')).toBe(true);

    // "Controls stay usable": nothing about the failed load disables the form.
    expect(el<HTMLTextAreaElement>(doc, 'intent').disabled).toBe(false);
    expect(el<HTMLButtonElement>(doc, 'compile').disabled).toBe(false);
    expect(el<HTMLButtonElement>(doc, 'recompile').disabled).toBe(false);
    expect(el<HTMLButtonElement>(doc, 'reset-stats').disabled).toBe(false);

    doc.dispatchEvent(new Event('unload'));
  });

  it('recovers once a later getState succeeds: the next refresh tick fills the intent textarea', async () => {
    vi.useFakeTimers();
    const doc = loadDoc();
    let getStateCalls = 0;
    const send = makeFakeSend((req) => {
      if (req.type !== 'getState') return { ok: false, error: 'unhandled' };
      getStateCalls += 1;
      return getStateCalls === 1 ? { ok: false, error: 'boom' } : getStateResponse();
    });
    await initPopup(doc, { send: asSend(send) });
    expect(el<HTMLTextAreaElement>(doc, 'intent').value).toBe(''); // not filled: the initial load failed

    await vi.advanceTimersByTimeAsync(2000);

    expect(el<HTMLTextAreaElement>(doc, 'intent').value).toBe(SETTINGS.intent);
    expect(el(doc, 'strictness-value').textContent).toBe('50%');
    expect(el(doc, 'compile-status').textContent).toBe(''); // the stale "couldn't reach..." message is cleared on recovery
    expect(el(doc, 'compile-status').classList.contains('error')).toBe(false);

    doc.dispatchEvent(new Event('unload'));
  });

  // --- Generic sites (design addendum §4): the "This site" section ---

  describe('#this-site', () => {
    /** Installs the chrome stub with `url` as the active tab's — the section reads `tabs.query`'s
     * `url` (available because the manifest asks for `activeTab`) to decide which state to show. */
    function withActiveTabUrl(url: string | undefined): ChromeStub {
      const stub = installChromeStub();
      stub.setTabs([{ id: 7, ...(url === undefined ? {} : { url }) }]);
      return stub;
    }

    /** A fake `send` that answers getState with `genericSites` and echoes enable/disable back with the
     * resulting list, recording every request (interleaved with permission calls) in `log`. */
    function sendWithSites(genericSites: string[], log: string[]) {
      let sites = [...genericSites];
      return makeFakeSend((req) => {
        log.push(req.type);
        if (req.type === 'getState') return getStateResponse({ genericSites: sites });
        if (req.type === 'enableSite') {
          sites = [...new Set([...sites, req.origin])].sort();
          return { ok: true, type: 'enableSite', genericSites: sites };
        }
        if (req.type === 'disableSite') {
          sites = sites.filter((o) => o !== req.origin);
          return { ok: true, type: 'disableSite', genericSites: sites };
        }
        return { ok: false, error: 'unhandled' };
      });
    }

    /** Origin patterns whose permission prompt the user "declines" (see `spyOnPermissionRequest`). */
    const DENY = new Set<string>();

    /** Spies on the stub's `chrome.permissions.request`, appending `permissions.request` to `log` so a
     * test can assert it happened BEFORE the enableSite message (Chrome needs the user gesture). The
     * cast narrows `chrome.permissions` to the one promise-returning overload `vi.spyOn` can mock. */
    function spyOnPermissionRequest(log: string[]) {
      const { permissions } = (globalThis as unknown as { chrome: { permissions: { request(p: { origins?: string[] }): Promise<boolean> } } }).chrome;
      return vi.spyOn(permissions, 'request').mockImplementation(async (perm) => {
        log.push('permissions.request');
        return !(perm.origins ?? []).some((o) => DENY.has(o));
      });
    }

    afterEach(() => {
      DENY.clear();
      vi.restoreAllMocks();
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it.each(['https://x.com/home', 'https://twitter.com/home', 'https://www.reddit.com/r/rust', 'https://news.ycombinator.com/'])(
      'shows %s as built in, with no button',
      async (url) => {
        withActiveTabUrl(url);
        const doc = loadDoc();
        await initPopup(doc, { send: asSend(sendWithSites([], [])) });

        expect(el(doc, 'site-origin').textContent).toBe(new URL(url).origin);
        expect(el(doc, 'site-status').textContent).toBe('built in');
        expect(el<HTMLButtonElement>(doc, 'site-toggle').hidden).toBe(true);

        doc.dispatchEvent(new Event('unload'));
      },
    );

    // Fix wave, I6b: the built-in list now comes from manifest.json (built-in-hosts.ts) rather than a
    // regex that matched every reddit.com subdomain. old.reddit.com is NOT injected by the manifest and
    // no adapter claims it, so labelling it `built in` hid the one control that would make it work.
    it('offers old.reddit.com the per-origin opt-in rather than calling it built in', async () => {
      withActiveTabUrl('https://old.reddit.com/r/programming');
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(sendWithSites([], [])) });

      expect(el(doc, 'site-origin').textContent).toBe('https://old.reddit.com');
      expect(el(doc, 'site-status').textContent).toBe('');
      const toggle = el<HTMLButtonElement>(doc, 'site-toggle');
      expect(toggle.hidden).toBe(false);
      expect(toggle.textContent).toBe('Enable on this site');

      doc.dispatchEvent(new Event('unload'));
    });

    it.each(['chrome://extensions/', 'about:blank', 'chrome-extension://abc/popup.html', undefined])(
      'shows %s as not a web page, with no button',
      async (url) => {
        withActiveTabUrl(url);
        const doc = loadDoc();
        await initPopup(doc, { send: asSend(sendWithSites([], [])) });

        expect(el(doc, 'site-status').textContent).toBe('not a web page');
        expect(el<HTMLButtonElement>(doc, 'site-toggle').hidden).toBe(true);

        doc.dispatchEvent(new Event('unload'));
      },
    );

    it('offers to enable an http(s) origin that is not in genericSites', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(sendWithSites([], [])) });

      expect(el(doc, 'site-origin').textContent).toBe('https://mastodon.social');
      const toggle = el<HTMLButtonElement>(doc, 'site-toggle');
      expect(toggle.hidden).toBe(false);
      expect(toggle.textContent).toBe('Enable on this site');
      expect(doc.querySelectorAll('#generic-sites li')).toHaveLength(0);

      doc.dispatchEvent(new Event('unload'));
    });

    it('asks Chrome for the host permission BEFORE sending enableSite, then shows the site as enabled', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const log: string[] = [];
      const doc = loadDoc();
      const send = sendWithSites([], log);
      const requestSpy = spyOnPermissionRequest(log);
      await initPopup(doc, { send: asSend(send) });

      el<HTMLButtonElement>(doc, 'site-toggle').click();
      await flush();

      expect(requestSpy).toHaveBeenCalledWith({ origins: ['https://mastodon.social/*'] });
      // The permission prompt must come first: the background has no user gesture to spend.
      expect(log.filter((e) => e !== 'getState')).toEqual(['permissions.request', 'enableSite']);

      expect(el<HTMLButtonElement>(doc, 'site-toggle').textContent).toBe('Disable on this site');
      expect(el(doc, 'site-status').textContent).toBe('enabled — reload the tab to start judging');
      const items = doc.querySelectorAll('#generic-sites li');
      expect(items).toHaveLength(1);
      expect(items[0]?.textContent).toContain('https://mastodon.social');

      doc.dispatchEvent(new Event('unload'));
    });

    it('sends nothing when the permission prompt is declined, and says so', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const log: string[] = [];
      const doc = loadDoc();
      const send = sendWithSites([], log);
      DENY.add('https://mastodon.social/*');
      spyOnPermissionRequest(log);
      await initPopup(doc, { send: asSend(send) });

      el<HTMLButtonElement>(doc, 'site-toggle').click();
      await flush();

      expect(log).not.toContain('enableSite');
      expect(el(doc, 'site-status').textContent).toBe('permission declined');
      expect(el<HTMLButtonElement>(doc, 'site-toggle').textContent).toBe('Enable on this site');
      expect(doc.querySelectorAll('#generic-sites li')).toHaveLength(0);

      doc.dispatchEvent(new Event('unload'));
    });

    it('shows an ok:false enableSite error and leaves the button on Enable', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const doc = loadDoc();
      spyOnPermissionRequest([]);
      const send = makeFakeSend((req) => (req.type === 'getState' ? getStateResponse() : { ok: false, error: 'invalid origin' }));
      await initPopup(doc, { send: asSend(send) });

      el<HTMLButtonElement>(doc, 'site-toggle').click();
      await flush();

      expect(el(doc, 'site-status').textContent).toBe('invalid origin');
      expect(el(doc, 'site-status').classList.contains('error')).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'site-toggle').textContent).toBe('Enable on this site');

      doc.dispatchEvent(new Event('unload'));
    });

    it('an already-enabled origin offers Disable, and clicking it disables without a permission prompt', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const log: string[] = [];
      const doc = loadDoc();
      const send = sendWithSites(['https://mastodon.social'], log);
      const requestSpy = spyOnPermissionRequest(log);
      await initPopup(doc, { send: asSend(send) });

      const toggle = el<HTMLButtonElement>(doc, 'site-toggle');
      expect(toggle.textContent).toBe('Disable on this site');
      expect(el(doc, 'site-status').textContent).toBe('enabled');

      toggle.click();
      await flush();

      expect(requestSpy).not.toHaveBeenCalled();
      expect(log).toContain('disableSite');
      expect(toggle.textContent).toBe('Enable on this site');
      // Fix wave, I3: unregistering the content script does not stop the copy already running in an
      // open tab, so the status says what the user still has to do — the mirror image of the enable line.
      expect(el(doc, 'site-status').textContent).toBe('disabled — reload the tab to stop judging');
      expect(doc.querySelectorAll('#generic-sites li')).toHaveLength(0);

      doc.dispatchEvent(new Event('unload'));
    });

    // Fix wave, I6c: `chrome.permissions.request` can reject outright (an invalidated extension
    // context, a gesture Chrome considers spent). That is not a decline — nothing was asked and
    // nothing must be sent — and the popup has to say which of the two happened.
    it('reports a rejecting permission request as a failure, and sends nothing', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const log: string[] = [];
      const doc = loadDoc();
      const send = sendWithSites([], log);
      const { permissions } = (globalThis as unknown as { chrome: { permissions: { request(p: { origins?: string[] }): Promise<boolean> } } }).chrome;
      vi.spyOn(permissions, 'request').mockRejectedValue(new Error('user gesture required'));
      await initPopup(doc, { send: asSend(send) });

      el<HTMLButtonElement>(doc, 'site-toggle').click();
      await flush();

      expect(log).not.toContain('enableSite');
      expect(el(doc, 'site-status').textContent).toBe('permission request failed: user gesture required');
      expect(el(doc, 'site-status').classList.contains('error')).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'site-toggle').textContent).toBe('Enable on this site');
      expect(doc.querySelectorAll('#generic-sites li')).toHaveLength(0);

      doc.dispatchEvent(new Event('unload'));
    });

    it('lists every enabled origin, and a remove link disables that one', async () => {
      withActiveTabUrl('https://mastodon.social/home');
      const log: string[] = [];
      const doc = loadDoc();
      const send = sendWithSites(['https://lobste.rs', 'https://mastodon.social'], log);
      await initPopup(doc, { send: asSend(send) });

      const items = [...doc.querySelectorAll('#generic-sites li')];
      expect(items.map((li) => li.textContent)).toEqual(['https://lobste.rs remove', 'https://mastodon.social remove']);

      items[0]?.querySelector('a')?.click();
      await flush();

      const disables = send.mock.calls.map(([req]) => req).filter((req) => req.type === 'disableSite');
      expect(disables).toHaveLength(1);
      if (disables[0]?.type === 'disableSite') expect(disables[0].origin).toBe('https://lobste.rs');
      expect([...doc.querySelectorAll('#generic-sites li')].map((li) => li.textContent)).toEqual(['https://mastodon.social remove']);
      // The active tab is still enabled, so its own button is untouched by removing another origin.
      expect(el<HTMLButtonElement>(doc, 'site-toggle').textContent).toBe('Disable on this site');

      doc.dispatchEvent(new Event('unload'));
    });

    it('takes the active tab url from deps when given (the popup-in-a-tab test hook)', async () => {
      withActiveTabUrl('chrome-extension://abc/popup.html');
      const doc = loadDoc();
      const send = sendWithSites(['https://mastodon.social'], []);
      await initPopup(doc, { send: asSend(send), activeTabUrl: 'https://mastodon.social/home' });

      expect(el(doc, 'site-origin').textContent).toBe('https://mastodon.social');
      expect(el(doc, 'site-status').textContent).toBe('enabled');

      doc.dispatchEvent(new Event('unload'));
    });
  });

  // --- Reading mode (design addendum §7): the "Read this page" section ---

  describe('#reading', () => {
    /** Installs the stub with one active tab, optionally alongside other tabs the `?jd-tab=` hook
     * could name instead. */
    function withTabs(tabs: Array<{ id?: number; url?: string; title?: string }>): ChromeStub {
      const stub = installChromeStub();
      stub.setTabs(tabs);
      return stub;
    }

    /** Spies on the stub's executeScript, recording the injection and resolving `result` as Chrome's
     * InjectionResult would. The cast narrows chrome.scripting to the one method being mocked. */
    function spyOnExecuteScript(result: unknown) {
      const { scripting } = (globalThis as unknown as { chrome: { scripting: { executeScript(o: unknown): Promise<unknown> } } }).chrome;
      return vi.spyOn(scripting, 'executeScript').mockResolvedValue([{ result }]);
    }

    const stateSend = () => makeFakeSend((req) => (req.type === 'getState' ? getStateResponse({ focus: 'why does it work' }) : { ok: true, type: 'setSettings' }));

    afterEach(() => {
      vi.restoreAllMocks();
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it('fills the focus box from settings and saves it 300ms after the last keystroke', async () => {
      vi.useFakeTimers();
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const doc = loadDoc();
      const calls: Request[] = [];
      const send = makeFakeSend((req) => {
        calls.push(req);
        return req.type === 'getState' ? getStateResponse({ focus: 'why does it work' }) : { ok: true, type: 'setSettings' };
      });
      await initPopup(doc, { send: asSend(send) });

      const focus = el<HTMLInputElement>(doc, 'focus');
      expect(focus.value).toBe('why does it work');

      focus.value = 'how is position represented';
      focus.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(299);
      expect(calls.filter((c) => c.type === 'setSettings')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const patches = calls.filter((c) => c.type === 'setSettings').map((c) => (c.type === 'setSettings' ? c.patch : undefined));
      expect(patches).toEqual([{ focus: 'how is position represented' }]);

      doc.dispatchEvent(new Event('unload'));
    });

    it('offers Read this page on an ordinary http(s) page', async () => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').hidden).toBe(false);
      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(false);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(true);
      expect(el(doc, 'read-status').textContent).toBe('');

      doc.dispatchEvent(new Event('unload'));
    });

    it.each(['https://example.test/paper.PDF', 'https://arxiv.org/pdf/1706.03762'])('offers Read this PDF for %s', async (url) => {
      withTabs([{ id: 7, url }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').hidden).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(false);

      doc.dispatchEvent(new Event('unload'));
    });

    it('disables Read this page on a chrome:// tab and says why', async () => {
      withTabs([{ id: 7, url: 'chrome://extensions/' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      expect(el<HTMLButtonElement>(doc, 'read-page').disabled).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(true);
      expect(el(doc, 'read-status').textContent).toBe('not a web page');

      doc.dispatchEvent(new Event('unload'));
    });

    it('injects read-page.js into the active tab and reports the passage count', async () => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      const spy = spyOnExecuteScript({ state: 'started', passages: 21 });
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(spy).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['read-page.js'] });
      expect(el(doc, 'read-status').textContent).toBe('reading 21 passages');

      doc.dispatchEvent(new Event('unload'));
    });

    it.each([
      [{ state: 'stopped' }, 'stopped'],
      [{ state: 'no-article', passages: 3 }, 'this page does not look like an article (3 passages)'],
      [undefined, 'reading'],
    ])('reports %j as %s', async (result, expected) => {
      withTabs([{ id: 7, url: 'https://example.test/post' }]);
      spyOnExecuteScript(result);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe(expected);
      doc.dispatchEvent(new Event('unload'));
    });

    // Final wave: the one read-page path with no executeScript call at all. A tab Chrome answers with
    // no `id` (it happens for a tab still being created, and for a devtools/PDF viewer target) is
    // unaddressable, so the popup says so instead of injecting into the wrong tab or silently nothing.
    it('says so, and injects nothing, when the active tab has no id', async () => {
      withTabs([{ url: 'https://example.test/post' }]); // a URL but no id
      const spy = spyOnExecuteScript({ state: 'started', passages: 21 });
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe("can't read this tab: no tab id");
      expect(el(doc, 'read-status').classList.contains('error')).toBe(true);
      expect(spy).not.toHaveBeenCalled();

      doc.dispatchEvent(new Event('unload'));
    });

    it('reports a refused injection, and offers the PDF reader when the tab looks like a PDF', async () => {
      withTabs([{ id: 7, url: 'https://example.test/download', title: 'paper.pdf' }]);
      const { scripting } = (globalThis as unknown as { chrome: { scripting: { executeScript(o: unknown): Promise<unknown> } } }).chrome;
      vi.spyOn(scripting, 'executeScript').mockRejectedValue(new Error('Cannot access contents of the page'));
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(el(doc, 'read-status').textContent).toBe("can't read this tab: Cannot access contents of the page");
      expect(el(doc, 'read-status').classList.contains('error')).toBe(true);
      expect(el<HTMLButtonElement>(doc, 'read-pdf').hidden).toBe(false);

      doc.dispatchEvent(new Event('unload'));
    });

    it('Read this PDF opens the reader page on the tab url, and the hint link opens it empty', async () => {
      const stub = withTabs([{ id: 7, url: 'https://example.test/paper.pdf' }]);
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()) });

      el<HTMLButtonElement>(doc, 'read-pdf').click();
      el<HTMLAnchorElement>(doc, 'open-reader').click();
      await flush();

      expect(stub.createdTabs()).toEqual([
        `${EXTENSION_ORIGIN}/reader.html?src=${encodeURIComponent('https://example.test/paper.pdf')}`,
        `${EXTENSION_ORIGIN}/reader.html`,
      ]);

      doc.dispatchEvent(new Event('unload'));
    });

    it('takes the tab id from tabs.query({url}) under the ?jd-tab= hook', async () => {
      withTabs([
        { id: 7, url: `${EXTENSION_ORIGIN}/popup.html?jd-tab=x` },
        { id: 42, url: 'https://example.test/article' },
      ]);
      const spy = spyOnExecuteScript({ state: 'started', passages: 21 });
      const doc = loadDoc();
      await initPopup(doc, { send: asSend(stateSend()), activeTabUrl: 'https://example.test/article' });

      el<HTMLButtonElement>(doc, 'read-page').click();
      await flush();

      expect(spy).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['read-page.js'] });
      doc.dispatchEvent(new Event('unload'));
    });
  });
});
