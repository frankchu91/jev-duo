// Persistence for the extension: settings/examples/stats live in chrome.storage.local (survive a
// browser restart); the verdict cache mirror lives in chrome.storage.session (memory-only, cleared
// when the browser closes, which is the right lifetime for a cache keyed off a compiled pack).

import type { DuoStats } from '../core/duo';
import type { Verdict } from '../core/types';
import { DEFAULT_SETTINGS, type PageSeenReport, type Settings } from './messages';

const SETTINGS_KEY = 'settings';
const EXAMPLES_KEY = 'examples';
const STATS_KEY = 'stats';
const VERDICTS_KEY = 'verdicts';
const PAGE_SEEN_KEY = 'pageSeen';

/** Cap on how many `[key, Verdict]` pairs `saveVerdicts` will persist to chrome.storage.session — also
 * the capacity background.ts gives its in-memory LruCache, so the cache itself never holds more than
 * this many entries and every flush is already within bounds. */
export const MAX_VERDICTS = 2000;

/** Cap on remembered per-tab `pageSeen` reports, in storage and in background.ts's live map. Tabs
 * close without telling the service worker, so the set would otherwise only ever grow. */
export const MAX_PAGE_REPORTS = 50;

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

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Structural check only (mirrors learner.ts's `isExample`): enough to reject garbage without a full
 * schema. A single malformed entry here must never take down `init()` — see `loadVerdicts`. */
function isVerdictEntry(x: unknown): x is [string, Verdict] {
  if (!Array.isArray(x) || x.length !== 2) return false;
  const [key, verdict] = x;
  return typeof key === 'string' && isPlainObject(verdict) && 'itemId' in verdict && 'decision' in verdict && 'rules' in verdict && 'keeps' in verdict;
}

/** `chrome.storage.session` mirror of the in-memory verdict cache: oldest -> newest, same order as
 * `LruCache.entries()`, so replaying it with `.set()` into a fresh cache restores the same recency.
 * Filters out anything that isn't a well-formed `[string, Verdict]` pair (including a root value that
 * isn't even an array) — storage can hold arbitrary garbage from an older version or a corrupt write,
 * and one bad entry must not break every later handler by throwing during cache warm-up. */
export async function loadVerdicts(): Promise<Array<[string, Verdict]>> {
  const stored = await chrome.storage.session.get(VERDICTS_KEY);
  const raw = stored[VERDICTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isVerdictEntry);
}

/** Defensively caps at MAX_VERDICTS even though the caller's LruCache is already sized to match, so
 * storage.ts's own size contract holds regardless of what capacity a caller happens to configure. */
export async function saveVerdicts(entries: Array<[string, Verdict]>): Promise<void> {
  await chrome.storage.session.set({ [VERDICTS_KEY]: entries.slice(-MAX_VERDICTS) });
}

function isPageSeenReport(x: unknown): x is PageSeenReport {
  if (!isPlainObject(x)) return false;
  return typeof x.tabId === 'number' && typeof x.platform === 'string' && typeof x.seen === 'number' && typeof x.at === 'string';
}

/** The per-tab "how many posts did the content script find" reports, oldest -> newest. They live in
 * chrome.storage.session rather than only in memory because Chrome evicts an idle MV3 service worker
 * after ~30 seconds: without this, a page whose adapter found nothing (the one case the popup most
 * needs to report) would come back as "no page report yet" the moment the worker restarted. Garbage
 * is filtered out the same way `loadVerdicts` does it — one bad entry must not break `init()`. */
export async function loadPageSeen(): Promise<PageSeenReport[]> {
  const stored = await chrome.storage.session.get(PAGE_SEEN_KEY);
  const raw = stored[PAGE_SEEN_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPageSeenReport).slice(-MAX_PAGE_REPORTS);
}

export async function savePageSeen(reports: PageSeenReport[]): Promise<void> {
  await chrome.storage.session.set({ [PAGE_SEEN_KEY]: reports.slice(-MAX_PAGE_REPORTS) });
}
