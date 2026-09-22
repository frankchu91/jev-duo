import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verdictKey } from '../../../src/core/cache';
import { AUTO_RECOMPILE_EVERY } from '../../../src/core/constants';
import type { Example, Item, Verdict } from '../../../src/core/types';
import { createBackground } from '../../../src/extension/background';
import type { Response as MessageResponse } from '../../../src/extension/messages';
import { EXTENSION_ORIGIN, installChromeStub, type ChromeStub } from './chrome-stub';

const mkItem = (id: string): Item => ({ id, platform: 'generic', text: `post ${id}` });
const mkExample = (id: string): Example => ({
  item: mkItem(id),
  expected: 'hide',
  actualDecision: { kind: 'keep' },
  source: 'user',
  at: '2026-01-01T00:00:00.000Z',
});

/** The debounce window background.ts coalesces verdict-cache mirror writes over. */
const VERDICT_FLUSH_MS = 2000;

describe('background', () => {
  let stub: ChromeStub;

  // Fake timers for the whole file, not just the tests that advance them: a judge now leaves a
  // pending (debounced) verdict-mirror write behind, and a real one would fire seconds later, inside
  // a LATER test, writing into that test's freshly installed storage stub. useRealTimers() in
  // afterEach drops whatever is still queued.
  beforeEach(() => {
    vi.useFakeTimers();
    stub = installChromeStub();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('compile', () => {
    it('with mock providers produces a pack and persists it to settings storage', async () => {
      const bg = createBackground();
      await bg.ready;

      const res = await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      expect(res.ok).toBe(true);
      if (!res.ok || res.type !== 'compile') throw new Error('expected a compile response');
      expect(res.pack.intent).toBe('Hide spam.');
      expect(res.pack.rules[0]?.id).toBe('spam');

      const stored = await chrome.storage.local.get('settings');
      const settings = stored.settings as { pack?: unknown; intent?: string };
      expect(settings.pack).toEqual(res.pack);
      expect(settings.intent).toBe('Hide spam.');
    });
  });

  describe('recompile', () => {
    it('before any pack exists returns ok:false', async () => {
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'recompile' });
      expect(res).toEqual({ ok: false, error: 'no pack' });
    });

    it('re-compiles the current pack intent and persists the result', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      const res = await bg.handle({ type: 'recompile' });
      expect(res.ok).toBe(true);
      if (!res.ok || res.type !== 'recompile') throw new Error('expected a recompile response');
      expect(res.pack.intent).toBe('Hide spam.');
    });
  });

  describe('judge', () => {
    it('before compile returns ok:false with "no pack compiled yet"', async () => {
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      expect(res).toEqual({ ok: false, error: 'no pack compiled yet' });
    });

    it('after compile, with mockFixtures set, folds the fixture item deterministically', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;

      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      const res = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      expect(res.ok).toBe(true);
      if (!res.ok || res.type !== 'judge') throw new Error('expected a judge response');
      expect(res.verdicts).toHaveLength(1);
      expect(res.verdicts[0]).toMatchObject({ itemId: 'a', source: 'jev', decision: { kind: 'fold', ruleId: 'spam' } });
    });

    it('persists stats immediately and flushes the verdict cache to chrome.storage.session after the debounce', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'judge', items: [mkItem('a')] });

      const stats = (await chrome.storage.local.get('stats')).stats as { judged: number } | undefined;
      expect(stats?.judged).toBe(1);

      expect((await chrome.storage.session.get('verdicts')).verdicts).toBeUndefined(); // still pending
      await vi.advanceTimersByTimeAsync(VERDICT_FLUSH_MS);

      const verdicts = (await chrome.storage.session.get('verdicts')).verdicts as Array<[string, unknown]> | undefined;
      expect(verdicts).toHaveLength(1);
    });

    // Each flush rewrites the WHOLE cache, so one write per judge turned a scroll (a judge every few
    // hundred ms) into a continuous stream of full-cache writes to chrome.storage.session.
    it('coalesces two judges inside the debounce window into a single chrome.storage.session write', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 }, b: { r_spam: 0.1 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      const sessionSet = vi.spyOn(chrome.storage.session, 'set');
      await bg.handle({ type: 'judge', items: [mkItem('a')] });
      await vi.advanceTimersByTimeAsync(VERDICT_FLUSH_MS / 2); // inside the window: resets the timer
      await bg.handle({ type: 'judge', items: [mkItem('b')] });
      expect(sessionSet).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(VERDICT_FLUSH_MS);
      expect(sessionSet).toHaveBeenCalledTimes(1);

      const verdicts = (await chrome.storage.session.get('verdicts')).verdicts as Array<[string, unknown]> | undefined;
      expect(verdicts).toHaveLength(2); // one write, but both items' verdicts in it
    });
  });

  describe('feedback', () => {
    it('reports recompiled:false before the auto-recompile threshold', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      const res = await bg.handle({ type: 'feedback', example: mkExample('e0') });
      expect(res).toMatchObject({ ok: true, type: 'feedback', recompiled: false, exampleCount: 1 });
    });

    it(`accumulates examples and reports recompiled:true on the ${AUTO_RECOMPILE_EVERY}th user example`, async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      let last: MessageResponse | undefined;
      for (let i = 0; i < AUTO_RECOMPILE_EVERY; i++) {
        last = await bg.handle({ type: 'feedback', example: mkExample(`e${i}`) });
        expect(last.ok).toBe(true);
      }
      expect(last).toMatchObject({ ok: true, type: 'feedback', recompiled: true, exampleCount: AUTO_RECOMPILE_EVERY });

      const stored = (await chrome.storage.local.get('examples')).examples as { examples: unknown[]; sinceRecompile: number } | undefined;
      expect(stored?.examples).toHaveLength(AUTO_RECOMPILE_EVERY);
      // RULING (d): recompile() calls markRecompiled() (sinceRecompile -> 0) on the live store AFTER
      // the pre-recompile save already persisted sinceRecompile === 10; the persisted JSON must reflect
      // the post-recompile counter, not the stale one, or a restart would immediately auto-recompile again.
      expect(stored?.sinceRecompile).toBe(0);
    });
  });

  describe('setSettings', () => {
    it('changes later judge decisions: a cache hit is re-decided at the new strictness', async () => {
      // Ambiguous at the default strictness (0.5, threshold 0.7): 0.6 sits inside [0.45, 0.7), so it
      // is pending-arbiter; with the arbiter disabled that fails open to keep. At strictness 1 the
      // effective threshold drops to 0.5, so the very same cached probability now clears it outright.
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.6 } }, arbiter: false } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      const first = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      if (!first.ok || first.type !== 'judge') throw new Error('expected a judge response');
      expect(first.verdicts[0]).toMatchObject({ source: 'jev', decision: { kind: 'keep' } });

      const setRes = await bg.handle({ type: 'setSettings', patch: { strictness: 1 } });
      expect(setRes).toEqual({ ok: true, type: 'setSettings' });

      const second = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      if (!second.ok || second.type !== 'judge') throw new Error('expected a judge response');
      expect(second.verdicts[0]).toMatchObject({ source: 'cache', decision: { kind: 'fold', ruleId: 'spam' } });
    });

    // saveSettings has already committed by the time the verdict mirror is flushed, so a rejecting
    // chrome.storage.session must not abort the rebuild: the persisted settings would then be ahead
    // of the live agent (and of every judge it makes) until the next service-worker restart.
    it('still rebuilds the agent when flushing the verdict mirror throws', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'judge', items: [mkItem('a')] }); // schedules the debounced flush

      vi.spyOn(chrome.storage.session, 'set').mockRejectedValue(new Error('session storage is full'));

      const res = await bg.handle({ type: 'setSettings', patch: { strictness: 0.9 } });
      expect(res).toEqual({ ok: true, type: 'setSettings' });

      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.settings.strictness).toBe(0.9); // the patch reached the live agent, not just storage
      expect(state.stats.judged).toBe(0); // ...via a real rebuild
    });

    it('rebuilds the agent but keeps the compiled pack and accumulated examples', async () => {
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'feedback', example: mkExample('e0') });

      await bg.handle({ type: 'setSettings', patch: { strictness: 0.9 } });

      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.settings.pack?.intent).toBe('Hide spam.');
      expect(state.settings.strictness).toBe(0.9);
      expect(state.exampleCount).toBe(1);
    });
  });

  describe('resetStats', () => {
    it('zeroes the live stats via a fresh agent, keeping pack and examples', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'judge', items: [mkItem('a')] });

      const before = await bg.handle({ type: 'getState' });
      if (!before.ok || before.type !== 'getState') throw new Error('expected a getState response');
      expect(before.stats.judged).toBe(1);

      const res = await bg.handle({ type: 'resetStats' });
      expect(res).toEqual({ ok: true, type: 'resetStats' });

      const after = await bg.handle({ type: 'getState' });
      if (!after.ok || after.type !== 'getState') throw new Error('expected a getState response');
      expect(after.stats.judged).toBe(0);
      expect(after.settings.pack?.intent).toBe('Hide spam.');
    });
  });

  describe('getState / provider mapping', () => {
    it('reports hasKeys:false in (default) mock mode', async () => {
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'getState' });
      expect(res).toMatchObject({ ok: true, type: 'getState', hasKeys: false, exampleCount: 0 });
      if (res.ok && res.type === 'getState') expect(res.settings.providerMode).toBe('mock');
    });

    it('falls back to mock (hasKeys:false) when openrouter mode has no key', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'openrouter', keys: {} } });
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'getState' });
      expect(res).toMatchObject({ ok: true, hasKeys: false });
    });

    it('resolves live (hasKeys:true) once openrouter mode has its key', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'openrouter', keys: { openrouter: 'or-key' } } });
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'getState' });
      expect(res).toMatchObject({ ok: true, hasKeys: true });
    });

    it('falls back to mock when typesafe mode is missing its key, even if an anthropic key is present', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'typesafe', keys: { anthropic: 'an-key' } } });
      const bg = createBackground();
      await bg.ready;
      const res = await bg.handle({ type: 'getState' });
      expect(res).toMatchObject({ ok: true, hasKeys: false });
    });

    it('typesafe mode with only the typesafe key: hasKeys:true, llm falls back to mock', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'typesafe', keys: { typesafe: 'ts-key' } } });
      const bg = createBackground();
      await bg.ready;

      const state = await bg.handle({ type: 'getState' });
      expect(state).toMatchObject({ ok: true, hasKeys: true });
      // RULING (e): hasKeys means "Jev is live"; `providers` spells out both resolved names so the
      // popup can show that the slow brain specifically has fallen back to mock.
      if (state.ok && state.type === 'getState') expect(state.providers).toEqual({ jev: 'typesafe', llm: 'mock' });

      const compiled = await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      if (!compiled.ok || compiled.type !== 'compile') throw new Error('expected a compile response');
      expect(compiled.pack.compiledBy).toBe('mock'); // no anthropic key: llm degrades to mock
    });

    it('reports providers: {jev:"mock", llm:"mock"} in default mock mode', async () => {
      const bg = createBackground();
      await bg.ready;
      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.providers).toEqual({ jev: 'mock', llm: 'mock' });
    });
  });

  describe('error handling', () => {
    it('handle() never throws: a provider failure yields ok:false', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'openrouter', keys: { openrouter: 'or-key' } } });
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const bg = createBackground({ fetchImpl });
      await bg.ready;

      const res = await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected ok:false');
      expect(typeof res.error).toBe('string');
      expect(res.error.length).toBeGreaterThan(0);
    });

    it('an unknown/malformed request is caught rather than thrown', async () => {
      const bg = createBackground();
      await bg.ready;
      // @ts-expect-error deliberately malformed to exercise the catch-all
      const res = await bg.handle({ type: 'not-a-real-type' });
      expect(res.ok).toBe(false);
    });
  });

  describe('service-worker restart safety', () => {
    it('a second createBackground() picks up settings/examples/pack persisted by the first', async () => {
      const first = createBackground();
      await first.ready;
      await first.handle({ type: 'compile', intent: 'Hide spam.' });
      await first.handle({ type: 'feedback', example: mkExample('e0') });

      const second = createBackground();
      await second.ready;
      const state = await second.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.settings.pack?.intent).toBe('Hide spam.');
      expect(state.exampleCount).toBe(1);
    });

    // IMPORTANT #1: chrome.storage.session persists across a service-worker restart within the same
    // browser session, so a single malformed entry written under an older version (or corrupted some
    // other way) must not throw during cache warm-up and leave `agent` undefined for every handler for
    // the rest of the session — nor should it prevent well-formed entries from still being served.
    it('a garbled verdict cache (mixed valid/invalid entries, and a non-array root) never breaks init', async () => {
      const first = createBackground();
      await first.ready;
      const compiled = await first.handle({ type: 'compile', intent: 'Hide spam.' });
      if (!compiled.ok || compiled.type !== 'compile') throw new Error('expected a compile response');
      const pack = compiled.pack;
      const item = mkItem('cached-item');
      const key = await verdictKey(pack, item);
      const goodVerdict: Verdict = {
        itemId: item.id,
        rules: [{ ruleId: 'spam', p: 0.1 }],
        keeps: [],
        decision: { kind: 'keep' },
        latencyMs: 1,
        source: 'jev',
      };

      await chrome.storage.session.set({
        verdicts: [
          'garbage-not-an-entry',
          [42, goodVerdict], // key not a string
          [key, 'not-an-object'],
          [key, { itemId: 'x' }], // missing decision/rules/keeps
          null,
          [key, goodVerdict], // well-formed: must survive
        ],
      });

      const second = createBackground();
      await second.ready; // must not hang or leave the agent unusable

      const state = await second.handle({ type: 'getState' });
      expect(state.ok).toBe(true);

      const judged = await second.handle({ type: 'judge', items: [item] });
      if (!judged.ok || judged.type !== 'judge') throw new Error('expected a judge response');
      expect(judged.verdicts[0].source).toBe('cache'); // the surviving well-formed entry was warmed
    });
  });

  describe('concurrency safety', () => {
    // IMPORTANT #2: `agent`/`cache` are shared closure variables that setSettings/resetStats reassign;
    // onMessage can dispatch a judge and a setSettings before either resolves. A judge must always
    // persist ITS OWN (pre-rebuild) agent's stats, and a rebuild must not happen until that judge has
    // fully finished — otherwise the wrong instance's (possibly zeroed) stats get persisted, or the
    // rebuild races the still-running judge's cache flush.
    it('setSettings issued mid-judge waits for it, persists its stats, then rebuilds for the next call', async () => {
      // typesafe jev (real HTTP, controllable via fetchImpl) + mock llm (no anthropic key, no fetch at
      // all) cleanly separates "compile: instant" from "judge: hangs until released".
      await chrome.storage.local.set({ settings: { providerMode: 'typesafe', keys: { typesafe: 'ts-key' } } });

      let releaseFetch!: (res: globalThis.Response) => void;
      const gate = new Promise<globalThis.Response>((resolve) => {
        releaseFetch = resolve;
      });
      const fetchImpl = vi.fn().mockReturnValue(gate);

      const bg = createBackground({ fetchImpl });
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' }); // mock llm: instant, never touches fetchImpl

      const judgePromise = bg.handle({ type: 'judge', items: [mkItem('a')] });
      await vi.waitFor(() => {
        if (fetchImpl.mock.calls.length < 1) throw new Error('jev fetch not called yet');
      });

      // Issued while the judge above is still pending on `gate`.
      const setSettingsPromise = bg.handle({ type: 'setSettings', patch: { strictness: 1 } });

      releaseFetch(
        new Response(JSON.stringify({ model: 'jev-latest', answers: { r_spam: { type: 'noul', noul: 0.1 } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const [judgeRes, setRes] = await Promise.all([judgePromise, setSettingsPromise]);
      if (!judgeRes.ok || judgeRes.type !== 'judge') throw new Error('expected a judge response');
      expect(judgeRes.verdicts[0].source).toBe('jev');
      expect(setRes).toEqual({ ok: true, type: 'setSettings' });

      const persistedStats = (await chrome.storage.local.get('stats')).stats as { judged: number } | undefined;
      expect(persistedStats?.judged).toBe(1); // the judge that actually ran, not the rebuilt (zeroed) agent

      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.settings.strictness).toBe(1); // the rebuild happened
      expect(state.stats.judged).toBe(0); // ...and the live agent is the fresh, rebuilt one
    });

    // Pins down WHY the wait has to happen before ruling (c)'s cache-discard specifically: if a
    // provider-changing setSettings raced ahead of a still-running judge, the judge's own (delayed)
    // `saveVerdicts(currentCache.entries())` — using its pre-discard cache reference — would land
    // AFTER setSettings's `saveVerdicts([])` and silently resurrect the stale, wrong-provider entry.
    it('a provider-changing setSettings mid-judge still ends with the session verdict mirror cleared, not resurrected', async () => {
      await chrome.storage.local.set({ settings: { providerMode: 'typesafe', keys: { typesafe: 'ts-key' } } });

      let releaseFetch!: (res: globalThis.Response) => void;
      const gate = new Promise<globalThis.Response>((resolve) => {
        releaseFetch = resolve;
      });
      const fetchImpl = vi.fn().mockReturnValue(gate);

      const bg = createBackground({ fetchImpl });
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      const judgePromise = bg.handle({ type: 'judge', items: [mkItem('a')] });
      await vi.waitFor(() => {
        if (fetchImpl.mock.calls.length < 1) throw new Error('jev fetch not called yet');
      });

      // Adds an openrouter key while the judge above is still pending: providerMode/typesafe key are
      // unchanged, but ruling (c) is "any key", so this must still trigger the cache discard.
      const setSettingsPromise = bg.handle({ type: 'setSettings', patch: { keys: { typesafe: 'ts-key', openrouter: 'or-key' } } });

      releaseFetch(
        new Response(JSON.stringify({ model: 'jev-latest', answers: { r_spam: { type: 'noul', noul: 0.1 } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const [judgeRes, setRes] = await Promise.all([judgePromise, setSettingsPromise]);
      expect(judgeRes.ok).toBe(true);
      expect(setRes).toEqual({ ok: true, type: 'setSettings' });

      const session = (await chrome.storage.session.get('verdicts')).verdicts;
      expect(session).toEqual([]); // cleared, and not resurrected by the judge's delayed write
    });
  });

  describe('ruling (c): cache invalidation on provider change', () => {
    it('discards the in-memory cache and clears the session mirror when a key changes (even if providerMode does not)', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });

      const first = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      if (!first.ok || first.type !== 'judge') throw new Error('expected a judge response');
      expect(first.verdicts[0].source).toBe('jev');

      await vi.advanceTimersByTimeAsync(VERDICT_FLUSH_MS); // let the debounced mirror write land
      const sessionBefore = (await chrome.storage.session.get('verdicts')).verdicts;
      expect(sessionBefore).toHaveLength(1);

      // providerMode stays 'mock', but a key changed — must still count.
      await bg.handle({ type: 'setSettings', patch: { keys: { openrouter: 'or-key' } } });

      const sessionAfter = (await chrome.storage.session.get('verdicts')).verdicts;
      expect(sessionAfter).toEqual([]);

      const second = await bg.handle({ type: 'judge', items: [mkItem('a')] }); // same item, same pack
      if (!second.ok || second.type !== 'judge') throw new Error('expected a judge response');
      expect(second.verdicts[0].source).toBe('jev'); // NOT 'cache': the in-memory LruCache was discarded too
    });

    it('a settings change unrelated to providerMode/keys leaves the cache intact', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'judge', items: [mkItem('a')] });

      await bg.handle({ type: 'setSettings', patch: { strictness: 0.9 } }); // no provider/key change

      const second = await bg.handle({ type: 'judge', items: [mkItem('a')] });
      if (!second.ok || second.type !== 'judge') throw new Error('expected a judge response');
      expect(second.verdicts[0].source).toBe('cache'); // still cached
    });
  });

  describe('isSiteEnabled', () => {
    it('defaults to enabled for every site when nothing is stored', async () => {
      const bg = createBackground();
      await bg.ready;
      for (const platform of ['x', 'reddit', 'hn'] as const) {
        expect(await bg.handle({ type: 'isSiteEnabled', platform })).toEqual({ ok: true, type: 'isSiteEnabled', enabled: true });
      }
    });

    it('reports the stored per-site toggle, and only that site', async () => {
      await chrome.storage.local.set({ settings: { enabledSites: { x: false, reddit: true, hn: true } } });
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'x' })).toEqual({ ok: true, type: 'isSiteEnabled', enabled: false });
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'reddit' })).toEqual({ ok: true, type: 'isSiteEnabled', enabled: true });
    });

    // Generic sites are opt-in and off by default (fail-closed), gated by origin rather than the
    // enabledSites toggle the three built-ins use.
    it('generic: false by default, with no origin or an origin not in genericSites', async () => {
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'generic' })).toEqual({ ok: true, type: 'isSiteEnabled', enabled: false });
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'generic', origin: 'https://mastodon.social' })).toEqual({
        ok: true,
        type: 'isSiteEnabled',
        enabled: false,
      });
    });

    it('generic: true only for an origin exactly present in settings.genericSites', async () => {
      await chrome.storage.local.set({ settings: { genericSites: ['https://mastodon.social'] } });
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'generic', origin: 'https://mastodon.social' })).toEqual({
        ok: true,
        type: 'isSiteEnabled',
        enabled: true,
      });
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'generic', origin: 'https://other.example' })).toEqual({
        ok: true,
        type: 'isSiteEnabled',
        enabled: false,
      });
      // The built-ins are unaffected by genericSites.
      expect(await bg.handle({ type: 'isSiteEnabled', platform: 'x' })).toEqual({ ok: true, type: 'isSiteEnabled', enabled: true });
    });
  });

  // The keys in `Settings` must not be reachable from a page's world. getState carries them, so it is
  // refused whenever the message came from a tab; everything a content script actually needs still works.
  describe('content-script isolation', () => {
    const fromTab = { tab: { id: 1 }, origin: 'https://x.com' };

    it('refuses getState from a tab, but serves it to the popup (no sender)', async () => {
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'getState' }, fromTab)).toEqual({ ok: false, error: 'getState is not available to content scripts' });
      expect(await bg.handle({ type: 'getState' })).toMatchObject({ ok: true, type: 'getState' });
    });

    // The action popup has no tab, but the same page opened in a tab of its own (which is how the
    // e2e suite reaches it) does — and it is still extension UI, identified by its origin, which
    // nothing running in a web page can report.
    it('serves getState to an extension page opened in a tab, identified by its origin', async () => {
      const bg = createBackground();
      await bg.ready;
      const fromExtensionTab = { tab: { id: 2 }, origin: EXTENSION_ORIGIN };
      expect(await bg.handle({ type: 'getState' }, fromExtensionTab)).toMatchObject({ ok: true, type: 'getState' });
    });

    it('refuses getState from a tab that reports no origin at all', async () => {
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'getState' }, { tab: { id: 3 } })).toEqual({ ok: false, error: 'getState is not available to content scripts' });
    });

    it('through the real onMessage listener: getState is refused, isSiteEnabled/judge/feedback are not', async () => {
      vi.resetModules();
      await import('../../../src/extension/background'); // registers its listener on the current stub
      await stub.dispatch({ type: 'compile', intent: 'Hide spam.' }, {}); // a pack, so judge can succeed

      expect(await stub.dispatch({ type: 'getState' }, fromTab)).toEqual({ ok: false, error: 'getState is not available to content scripts' });
      expect(await stub.dispatch({ type: 'isSiteEnabled', platform: 'x' }, fromTab)).toMatchObject({ ok: true, enabled: true });
      expect(await stub.dispatch({ type: 'judge', items: [mkItem('a')] }, fromTab)).toMatchObject({ ok: true, type: 'judge' });
      expect(await stub.dispatch({ type: 'feedback', example: mkExample('e0') }, fromTab)).toMatchObject({ ok: true, type: 'feedback' });
    });
  });

  describe('pageSeen (spec §8: "0 posts seen on this page")', () => {
    it('records the latest report per tab and returns them all from getState', async () => {
      const bg = createBackground();
      await bg.ready;

      expect(await bg.handle({ type: 'pageSeen', platform: 'x', seen: 6 }, { tab: { id: 7 } })).toEqual({ ok: true, type: 'pageSeen' });
      await bg.handle({ type: 'pageSeen', platform: 'hn', seen: 0 }, { tab: { id: 8 } });
      await bg.handle({ type: 'pageSeen', platform: 'x', seen: 11 }, { tab: { id: 7 } }); // replaces tab 7's earlier report

      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.pageSeen).toHaveLength(2);
      expect(state.pageSeen).toContainEqual(expect.objectContaining({ tabId: 7, platform: 'x', seen: 11 }));
      expect(state.pageSeen).toContainEqual(expect.objectContaining({ tabId: 8, platform: 'hn', seen: 0 }));
      expect(typeof state.pageSeen[0].at).toBe('string');
    });

    it('keeps at most 50 tabs, dropping the least recently reporting one', async () => {
      const bg = createBackground();
      await bg.ready;
      for (let tabId = 1; tabId <= 55; tabId++) {
        await bg.handle({ type: 'pageSeen', platform: 'x', seen: tabId }, { tab: { id: tabId } });
      }
      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.pageSeen).toHaveLength(50);
      expect(state.pageSeen.map((r) => r.tabId)).toEqual(Array.from({ length: 50 }, (_, i) => i + 6));
    });

    // Chrome evicts an idle MV3 service worker after ~30 seconds. A memory-only map meant that the
    // popup showed "no page report yet" instead of "0 posts seen on this page" in precisely the case
    // the line exists for: a broken adapter, on a page quiet enough for the worker to be evicted.
    it('survives a service-worker restart: a fresh background reads the reports back from session storage', async () => {
      const first = createBackground();
      await first.ready;
      await first.handle({ type: 'pageSeen', platform: 'hn', seen: 0 }, { tab: { id: 4 } });

      const second = createBackground(); // same session storage, brand new in-memory state
      await second.ready;
      const state = await second.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.pageSeen).toEqual([expect.objectContaining({ tabId: 4, platform: 'hn', seen: 0 })]);
    });

    it('a garbled pageSeen store never breaks init, and well-formed entries still survive', async () => {
      await chrome.storage.session.set({
        pageSeen: ['nope', null, { tabId: 'x', platform: 'hn', seen: 0, at: 'now' }, { tabId: 5 }, { tabId: 6, platform: 'x', seen: 2, at: 'now' }],
      });
      const bg = createBackground();
      await bg.ready;
      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.pageSeen).toEqual([{ tabId: 6, platform: 'x', seen: 2, at: 'now' }]);
    });

    it('a report with no tab id (not from a content script) is acknowledged and dropped', async () => {
      const bg = createBackground();
      await bg.ready;
      expect(await bg.handle({ type: 'pageSeen', platform: 'x', seen: 3 })).toEqual({ ok: true, type: 'pageSeen' });
      const state = await bg.handle({ type: 'getState' });
      if (!state.ok || state.type !== 'getState') throw new Error('expected a getState response');
      expect(state.pageSeen).toEqual([]);
    });
  });

  describe('module top-level wiring', () => {
    it('registers a chrome.runtime.onMessage listener that round-trips through messages.ts send()', async () => {
      vi.resetModules();
      await import('../../../src/extension/background');
      const { send } = await import('../../../src/extension/messages');

      const res = await send({ type: 'getState' });
      expect(res.ok).toBe(true);
      if (res.ok && res.type === 'getState') expect(res.settings.providerMode).toBe('mock');
    });
  });
});
