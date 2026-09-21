// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuoStats } from '../../../src/core/duo';
import type { QuestionPack } from '../../../src/core/types';
import type { Request, Response, Settings, send } from '../../../src/extension/messages';
import { initPopup } from '../../../src/extension/popup/popup';

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
  enabledSites: { x: true, reddit: true, hn: true },
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

function getStateResponse(overrides: Partial<Settings> = {}, stats: DuoStats = STATS, exampleCount = 4): Response {
  return {
    ok: true,
    type: 'getState',
    settings: { ...SETTINGS, ...overrides, keys: { ...SETTINGS.keys, ...overrides.keys }, enabledSites: { ...SETTINGS.enabledSites, ...overrides.enabledSites } },
    stats,
    exampleCount,
    hasKeys: false,
    providers: { jev: 'mock', llm: 'mock' },
  };
}

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
});
