// Typed contract between the content script (Task 9) / popup (Task 10) and the background service
// worker (background.ts). This is the only shape either side is allowed to depend on — nobody outside
// background.ts talks to `src/core` directly, since the native TypeSafe API rejects browser-page CORS
// and only the service worker (with host permissions) is exempt.

import type { DuoStats } from '../core/duo';
import type { DocContext, Passage, ReadingVerdict } from '../core/reading';
import type { Example, Item, QuestionPack, Verdict } from '../core/types';

export type SiteId = 'x' | 'reddit' | 'hn';

/** Every platform a content script can report itself as: the three built-ins plus `generic` (the
 * fallback adapter). Distinct from `SiteId`, which stays the three built-ins only — the popup's
 * per-site toggles (`Settings.enabledSites`) are keyed by `SiteId` and never gain a `generic` entry;
 * generic sites are gated by origin (`Settings.genericSites`) instead. */
export type PagePlatform = SiteId | 'generic';

export interface Settings {
  providerMode: 'mock' | 'openrouter' | 'typesafe'; // typesafe implies anthropic for llm if key present, else mock llm
  keys: { openrouter?: string; typesafe?: string; anthropic?: string };
  llmModel?: string;
  intent: string;
  pack?: QuestionPack;
  strictness: number; // 0..1, default 0.5
  arbiter: boolean; // default true
  focus: string; // reading mode's "what are you looking for?", inlined into the focus question; default ''
  enabledSites: Record<SiteId, boolean>; // default all true
  genericSites: string[]; // origins (e.g. "https://mastodon.social") the user opted the generic adapter into; default []
  mockFixtures?: Record<string, Record<string, number>>; // test hook
}

export const DEFAULT_SETTINGS: Settings = {
  providerMode: 'mock',
  keys: {},
  intent: '',
  strictness: 0.5,
  arbiter: true,
  focus: '',
  enabledSites: { x: true, reddit: true, hn: true },
  genericSites: [],
};

/** The slice of `chrome.runtime.MessageSender` the background actually reads. A message from a tab
 * whose `origin` is not the extension's own comes from a content script — it shares its world with
 * the page — which is what gates `getState` below. Both fields are set by the browser, so a page
 * cannot claim to be something it is not. (An extension page reports the extension origin whether it
 * runs as the action popup, with no `tab` at all, or opened in a tab of its own.) */
export interface Sender {
  tab?: { id?: number };
  origin?: string;
}

/** One content script's report of how many posts its adapter found on the page it runs in. */
export interface PageSeenReport {
  tabId: number;
  platform: PagePlatform;
  seen: number;
  at: string;
}

export type Request =
  | { type: 'judge'; items: Item[] }
  | { type: 'compile'; intent: string }
  | { type: 'recompile' }
  | { type: 'feedback'; example: Example }
  | { type: 'getState' }
  // `origin` (the page's `location.origin`) is how the generic adapter is gated: a built-in platform
  // ignores it, but `platform: 'generic'` is only ever answered `true` when the origin is in
  // `settings.genericSites` (see background.ts). Optional because the three built-ins don't need it.
  | { type: 'isSiteEnabled'; platform: PagePlatform; origin?: string }
  | { type: 'pageSeen'; platform: PagePlatform; seen: number }
  | { type: 'setSettings'; patch: Partial<Settings> }
  | { type: 'resetStats' }
  // Grants (or revokes) the generic adapter for one origin: registers (or unregisters) its dynamic
  // content script and updates `settings.genericSites` — see background.ts/sites.ts. Like `getState`,
  // both are refused for a content-script sender (only the popup may change which sites are enabled);
  // unlike `getState`, they carry no secrets, so the refusal is about write access, not privacy.
  | { type: 'enableSite'; origin: string }
  | { type: 'disableSite'; origin: string }
  // Reading mode (design addendum §9). Unlike `judge` this needs no compiled pack and is not gated by
  // enabledSites/genericSites: the user clicked Read on this document, and the click is the consent.
  // Any sender may call it — the reply carries probabilities about text the sender already has.
  | { type: 'readPassages'; ctx: DocContext; passages: Passage[] };

export type Response =
  | { ok: true; type: 'judge'; verdicts: Verdict[] }
  | { ok: true; type: 'compile' | 'recompile'; pack: QuestionPack }
  | { ok: true; type: 'feedback'; recompiled: boolean; exampleCount: number }
  // `settings` includes `keys` (raw API keys) verbatim, so getState is the popup's request and the
  // popup's alone: background.ts REJECTS it whenever the message came from a tab (a content script)
  // with `getState is not available to content scripts`, which makes "no keys in a page context" a
  // structural property rather than a convention. A page that needs to know whether it may run asks
  // `isSiteEnabled` instead, which answers one boolean and nothing else. `hasKeys` means "the Jev
  // provider is live"; `providers` gives the resolved provider names (e.g. `{jev:'typesafe',
  // llm:'mock'}`) so the popup can show when the slow brain in particular has fallen back to mock
  // even though Jev is live; `pageSeen` is the latest post count each content script reported.
  | {
      ok: true;
      type: 'getState';
      settings: Settings;
      stats: DuoStats;
      exampleCount: number;
      hasKeys: boolean;
      providers: { jev: string; llm: string };
      pageSeen: PageSeenReport[];
    }
  | { ok: true; type: 'isSiteEnabled'; enabled: boolean }
  | { ok: true; type: 'pageSeen' }
  | { ok: true; type: 'setSettings' | 'resetStats' }
  // `genericSites` is the FULL resulting list (sorted, unique) so the popup never has to derive it
  // locally from the request it just sent.
  | { ok: true; type: 'enableSite' | 'disableSite'; genericSites: string[] }
  // `focus` is the setting the background actually applied, echoed so the reader panel can show the
  // question the verdicts answer without reading Settings itself (a content script may not).
  | { ok: true; type: 'readPassages'; focus: string; verdicts: ReadingVerdict[]; usageTokens: number; errors: number }
  | { ok: false; error: string };

/** Wraps `chrome.runtime.sendMessage` in a Promise: resolves `{ok:false,error}` (never rejects) when
 * the runtime reports `lastError`, the background sends back no response, or the call throws
 * synchronously (e.g. an invalidated extension context) — the callback form is used throughout
 * because the Promise-returning overload of `sendMessage` is not reliable across Chrome versions. */
export function send<R extends Request>(req: R): Promise<Extract<Response, { type: R['type'] }> | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(req, (response: Response | undefined) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message ?? 'unknown runtime error' });
          return;
        }
        if (response === undefined) {
          resolve({ ok: false, error: 'no response from background' });
          return;
        }
        resolve(response as Extract<Response, { type: R['type'] }> | { ok: false; error: string });
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
