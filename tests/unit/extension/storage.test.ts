import { beforeEach, describe, expect, it } from 'vitest';
import type { DuoStats } from '../../../src/core/duo';
import type { Verdict } from '../../../src/core/types';
import { DEFAULT_SETTINGS, type PageSeenReport } from '../../../src/extension/messages';
import {
  loadExamples,
  loadPageSeen,
  loadSettings,
  loadStats,
  loadVerdicts,
  MAX_PAGE_REPORTS,
  MAX_VERDICTS,
  saveExamples,
  savePageSeen,
  saveSettings,
  saveStats,
  saveVerdicts,
} from '../../../src/extension/storage';
import { installChromeStub } from './chrome-stub';

const mkStats = (over: Partial<DuoStats> = {}): DuoStats => ({
  judged: 0,
  folded: 0,
  dimmed: 0,
  badged: 0,
  kept: 0,
  keptByRule: 0,
  errors: 0,
  cacheHits: 0,
  arbitrated: 0,
  p50LatencyMs: 0,
  estimatedUsd: 0,
  inputTokens: 0,
  lastSources: [],
  ...over,
});

const mkVerdict = (itemId: string): Verdict => ({
  itemId,
  rules: [],
  keeps: [],
  decision: { kind: 'keep' },
  latencyMs: 1,
  source: 'jev',
});

describe('extension storage', () => {
  beforeEach(() => {
    installChromeStub();
  });

  describe('settings', () => {
    it('loadSettings() on empty storage returns DEFAULT_SETTINGS', async () => {
      expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('saveSettings() persists a partial patch merged over DEFAULT_SETTINGS and returns the merged result', async () => {
      const saved = await saveSettings({ strictness: 0.9, intent: 'hide spam' });
      expect(saved).toEqual({ ...DEFAULT_SETTINGS, strictness: 0.9, intent: 'hide spam' });
      expect(await loadSettings()).toEqual(saved);
    });

    it('nested keys/enabledSites patches merge field-by-field instead of replacing the whole object', async () => {
      await saveSettings({ keys: { openrouter: 'or-key' } });
      const second = await saveSettings({ keys: { anthropic: 'an-key' } });
      expect(second.keys).toEqual({ openrouter: 'or-key', anthropic: 'an-key' });

      await saveSettings({ enabledSites: { x: false, reddit: true, hn: true } });
      const third = await loadSettings();
      expect(third.enabledSites).toEqual({ x: false, reddit: true, hn: true });
      expect(third.keys).toEqual({ openrouter: 'or-key', anthropic: 'an-key' }); // unrelated fields untouched
    });

    it('successive saveSettings calls accumulate rather than clobber unrelated fields', async () => {
      await saveSettings({ intent: 'hide spam' });
      await saveSettings({ strictness: 0.8 });
      const final = await loadSettings();
      expect(final.intent).toBe('hide spam');
      expect(final.strictness).toBe(0.8);
      expect(final.arbiter).toBe(DEFAULT_SETTINGS.arbiter); // never patched, stays default
    });
  });

  describe('examples', () => {
    it('loadExamples() is undefined before anything is saved', async () => {
      expect(await loadExamples()).toBeUndefined();
    });

    it('saveExamples()/loadExamples() round-trip arbitrary JSON', async () => {
      const json = { examples: [{ item: { id: 'a', text: 't' } }], sinceRecompile: 3 };
      await saveExamples(json);
      expect(await loadExamples()).toEqual(json);
    });
  });

  describe('stats', () => {
    it('loadStats() is undefined before anything is saved', async () => {
      expect(await loadStats()).toBeUndefined();
    });

    it('saveStats()/loadStats() round-trip', async () => {
      const stats = mkStats({ judged: 42, folded: 7, lastSources: ['jev', 'cache'] });
      await saveStats(stats);
      expect(await loadStats()).toEqual(stats);
    });
  });

  describe('verdicts (chrome.storage.session)', () => {
    it('loadVerdicts() is [] before anything is saved', async () => {
      expect(await loadVerdicts()).toEqual([]);
    });

    it('saveVerdicts()/loadVerdicts() round-trip [key, Verdict] pairs', async () => {
      const entries: Array<[string, Verdict]> = [
        ['k1', mkVerdict('a')],
        ['k2', mkVerdict('b')],
      ];
      await saveVerdicts(entries);
      expect(await loadVerdicts()).toEqual(entries);
    });

    it('saveVerdicts() caps storage at MAX_VERDICTS, keeping the most recent entries', async () => {
      const entries: Array<[string, Verdict]> = Array.from({ length: MAX_VERDICTS + 5 }, (_, i) => [String(i), mkVerdict(String(i))]);
      await saveVerdicts(entries);
      const loaded = await loadVerdicts();
      expect(loaded).toHaveLength(MAX_VERDICTS);
      expect(loaded[0][0]).toBe('5'); // the oldest 5 were dropped
      expect(loaded[loaded.length - 1][0]).toBe(String(MAX_VERDICTS + 4));
    });

    it('verdicts live in chrome.storage.session, never chrome.storage.local', async () => {
      await saveVerdicts([['k1', mkVerdict('a')]]);
      const local = await chrome.storage.local.get('verdicts');
      expect(local.verdicts).toBeUndefined();
      const session = await chrome.storage.session.get('verdicts');
      expect(session.verdicts).toEqual([['k1', mkVerdict('a')]]);
    });

    // IMPORTANT #1(a): a single malformed entry must never throw out of loadVerdicts() — it must be
    // dropped so init()'s cache warm can't blow up on it and leave `agent` undefined for the session.
    it('loadVerdicts() drops malformed entries, keeping only well-formed [string, Verdict] pairs', async () => {
      const good: [string, Verdict] = ['k1', mkVerdict('a')];
      await chrome.storage.session.set({
        verdicts: [
          good,
          'not-an-entry-at-all',
          [123, mkVerdict('b')], // key not a string
          ['k2', 'not-an-object'], // verdict not an object
          ['k3', { itemId: 'x' }], // object, but missing decision/rules/keeps
          ['k4'], // wrong length
          null,
          undefined,
        ],
      });
      expect(await loadVerdicts()).toEqual([good]);
    });

    it('loadVerdicts() returns [] when the stored value itself is not an array', async () => {
      await chrome.storage.session.set({ verdicts: 'totally-not-an-array' });
      expect(await loadVerdicts()).toEqual([]);
    });
  });

  // Session, not local: a post count describes a page that is open right now, and the point of
  // persisting it at all is only to outlive the service worker Chrome evicts after ~30s idle.
  describe('pageSeen (chrome.storage.session)', () => {
    const mkReport = (tabId: number, seen = 3): PageSeenReport => ({ tabId, platform: 'x', seen, at: '2026-01-01T00:00:00.000Z' });

    it('loadPageSeen() is [] before anything is saved', async () => {
      expect(await loadPageSeen()).toEqual([]);
    });

    it('savePageSeen()/loadPageSeen() round-trip the reports in order', async () => {
      const reports = [mkReport(1), mkReport(2, 0)];
      await savePageSeen(reports);
      expect(await loadPageSeen()).toEqual(reports);
      expect((await chrome.storage.local.get('pageSeen')).pageSeen).toBeUndefined();
    });

    it('savePageSeen() caps at MAX_PAGE_REPORTS, keeping the most recent tabs', async () => {
      await savePageSeen(Array.from({ length: MAX_PAGE_REPORTS + 5 }, (_, i) => mkReport(i)));
      const loaded = await loadPageSeen();
      expect(loaded).toHaveLength(MAX_PAGE_REPORTS);
      expect(loaded[0].tabId).toBe(5);
    });

    it('loadPageSeen() drops malformed entries and a non-array root, never throwing', async () => {
      const good = mkReport(7, 0);
      await chrome.storage.session.set({
        pageSeen: [good, 'nope', null, { tabId: '7', platform: 'x', seen: 0, at: 'now' }, { tabId: 8 }, { platform: 'x', seen: 1, at: 'now' }],
      });
      expect(await loadPageSeen()).toEqual([good]);

      await chrome.storage.session.set({ pageSeen: { not: 'an array' } });
      expect(await loadPageSeen()).toEqual([]);
    });
  });
});
