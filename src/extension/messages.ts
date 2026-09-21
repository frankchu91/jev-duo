// Typed contract between the content script (Task 9) / popup (Task 10) and the background service
// worker (background.ts). This is the only shape either side is allowed to depend on — nobody outside
// background.ts talks to `src/core` directly, since the native TypeSafe API rejects browser-page CORS
// and only the service worker (with host permissions) is exempt.

import type { DuoStats } from '../core/duo';
import type { Example, Item, QuestionPack, Verdict } from '../core/types';

export type SiteId = 'x' | 'reddit' | 'hn';

export interface Settings {
  providerMode: 'mock' | 'openrouter' | 'typesafe'; // typesafe implies anthropic for llm if key present, else mock llm
  keys: { openrouter?: string; typesafe?: string; anthropic?: string };
  llmModel?: string;
  intent: string;
  pack?: QuestionPack;
  strictness: number; // 0..1, default 0.5
  arbiter: boolean; // default true
  enabledSites: Record<SiteId, boolean>; // default all true
  mockFixtures?: Record<string, Record<string, number>>; // test hook
}

export const DEFAULT_SETTINGS: Settings = {
  providerMode: 'mock',
  keys: {},
  intent: '',
  strictness: 0.5,
  arbiter: true,
  enabledSites: { x: true, reddit: true, hn: true },
};

export type Request =
  | { type: 'judge'; items: Item[] }
  | { type: 'compile'; intent: string }
  | { type: 'recompile' }
  | { type: 'feedback'; example: Example }
  | { type: 'getState' }
  | { type: 'setSettings'; patch: Partial<Settings> }
  | { type: 'resetStats' };

export type Response =
  | { ok: true; type: 'judge'; verdicts: Verdict[] }
  | { ok: true; type: 'compile' | 'recompile'; pack: QuestionPack }
  | { ok: true; type: 'feedback'; recompiled: boolean; exampleCount: number }
  // `settings` includes `keys` (raw API keys) verbatim: the popup is the intended, sole reader of
  // getState, so only it should ever send this request. Never surface a getState-driven "settings"
  // view in the content script or any page context.
  | { ok: true; type: 'getState'; settings: Settings; stats: DuoStats; exampleCount: number; hasKeys: boolean }
  | { ok: true; type: 'setSettings' | 'resetStats' }
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
