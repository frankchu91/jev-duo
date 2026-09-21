import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_RECOMPILE_EVERY } from '../../../src/core/constants';
import type { Example, Item } from '../../../src/core/types';
import { createBackground } from '../../../src/extension/background';
import type { Response as MessageResponse } from '../../../src/extension/messages';
import { installChromeStub } from './chrome-stub';

const mkItem = (id: string): Item => ({ id, platform: 'generic', text: `post ${id}` });
const mkExample = (id: string): Example => ({
  item: mkItem(id),
  expected: 'hide',
  actualDecision: { kind: 'keep' },
  source: 'user',
  at: '2026-01-01T00:00:00.000Z',
});

describe('background', () => {
  beforeEach(() => {
    installChromeStub();
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

    it('persists stats and flushes the verdict cache to chrome.storage.session after judging', async () => {
      await chrome.storage.local.set({ settings: { mockFixtures: { a: { r_spam: 0.95 } } } });
      const bg = createBackground();
      await bg.ready;
      await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      await bg.handle({ type: 'judge', items: [mkItem('a')] });

      const stats = (await chrome.storage.local.get('stats')).stats as { judged: number } | undefined;
      expect(stats?.judged).toBe(1);

      const verdicts = (await chrome.storage.session.get('verdicts')).verdicts as Array<[string, unknown]> | undefined;
      expect(verdicts).toHaveLength(1);
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

      const stored = (await chrome.storage.local.get('examples')).examples as { examples: unknown[] } | undefined;
      expect(stored?.examples).toHaveLength(AUTO_RECOMPILE_EVERY);
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

      const compiled = await bg.handle({ type: 'compile', intent: 'Hide spam.' });
      if (!compiled.ok || compiled.type !== 'compile') throw new Error('expected a compile response');
      expect(compiled.pack.compiledBy).toBe('mock'); // no anthropic key: llm degrades to mock
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
