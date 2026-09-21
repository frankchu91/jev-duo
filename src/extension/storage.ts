// Persistence for the extension: settings/examples/stats live in chrome.storage.local (survive a
// browser restart); the verdict cache mirror lives in chrome.storage.session (memory-only, cleared
// when the browser closes, which is the right lifetime for a cache keyed off a compiled pack).

import type { DuoStats } from '../core/duo';
import type { Verdict } from '../core/types';
import { DEFAULT_SETTINGS, type Settings } from './messages';

const SETTINGS_KEY = 'settings';
const EXAMPLES_KEY = 'examples';
const STATS_KEY = 'stats';
const VERDICTS_KEY = 'verdicts';

/** Cap on how many `[key, Verdict]` pairs `saveVerdicts` will persist to chrome.storage.session — also
 * the capacity background.ts gives its in-memory LruCache, so the cache itself never holds more than
 * this many entries and every flush is already within bounds. */
export const MAX_VERDICTS = 2000;

async function getLocal<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.local.get(key);
  return stored[key] as T | undefined;
}

async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    keys: { ...base.keys, ...patch.keys },
    enabledSites: { ...base.enabledSites, ...patch.enabledSites },
  };
}

/** Merges whatever is persisted under 'settings' over DEFAULT_SETTINGS; a fresh install (nothing
 * stored yet) resolves to DEFAULT_SETTINGS unchanged. */
export async function loadSettings(): Promise<Settings> {
  const stored = await getLocal<Partial<Settings>>(SETTINGS_KEY);
  return mergeSettings(DEFAULT_SETTINGS, stored ?? {});
}

/** Merges `patch` over the currently persisted settings (not just the defaults) and persists the
 * result, so repeated partial patches accumulate instead of clobbering each other. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings(current, patch);
  await setLocal(SETTINGS_KEY, next);
  return next;
}

export async function loadExamples(): Promise<unknown> {
  return getLocal<unknown>(EXAMPLES_KEY);
}

export async function saveExamples(json: unknown): Promise<void> {
  await setLocal(EXAMPLES_KEY, json);
}

export async function loadStats(): Promise<DuoStats | undefined> {
  return getLocal<DuoStats>(STATS_KEY);
}

export async function saveStats(s: DuoStats): Promise<void> {
  await setLocal(STATS_KEY, s);
}

/** `chrome.storage.session` mirror of the in-memory verdict cache: oldest -> newest, same order as
 * `LruCache.entries()`, so replaying it with `.set()` into a fresh cache restores the same recency. */
export async function loadVerdicts(): Promise<Array<[string, Verdict]>> {
  const stored = await chrome.storage.session.get(VERDICTS_KEY);
  const raw = stored[VERDICTS_KEY];
  return Array.isArray(raw) ? (raw as Array<[string, Verdict]>) : [];
}

/** Defensively caps at MAX_VERDICTS even though the caller's LruCache is already sized to match, so
 * storage.ts's own size contract holds regardless of what capacity a caller happens to configure. */
export async function saveVerdicts(entries: Array<[string, Verdict]>): Promise<void> {
  await chrome.storage.session.set({ [VERDICTS_KEY]: entries.slice(-MAX_VERDICTS) });
}
