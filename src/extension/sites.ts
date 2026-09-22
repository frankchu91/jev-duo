// Dynamic per-site content-script registration for the generic adapter (design §4). Isolated from
// background.ts because it is the only place that touches chrome.scripting/chrome.permissions — the
// three built-in sites are matched by the STATIC content_scripts entry in manifest.json and never go
// through here at all.

import { fnv1a } from '../core/hash';

/** Every id this module registers starts with this prefix — also how `reconcileSites` below tells its
 * own dynamic registrations apart from anything else that might be registered under the same
 * extension (defence in depth: nothing else calls chrome.scripting today, but a future feature might). */
const ID_PREFIX = 'jd-';

const registrationId = (origin: string): string => `${ID_PREFIX}${fnv1a(origin)}`;

/** The exact registration spec for `origin` (design §4). `persistAcrossSessions: true` is what makes a
 * granted site survive a browser restart without re-registering here — `reconcileSites` only has to
 * repair drift (a revoked permission, a leftover script), not rebuild every registration from scratch. */
const registrationSpec = (origin: string): chrome.scripting.RegisteredContentScript => ({
  id: registrationId(origin),
  matches: [`${origin}/*`],
  js: ['content.js'],
  css: ['styles.css'],
  runAt: 'document_idle',
  persistAcrossSessions: true,
});

/** True when `origin` is exactly its own `new URL(origin).origin` (no path/query/fragment/trailing
 * slash) with an http(s) scheme. Guards both message handlers below: `origin` becomes a match pattern
 * (`origin + '/*'`) and a chrome.scripting id input, so anything short of an exact origin string could
 * register a pattern wider — or silently narrower, no-oping the user's click — than what the popup
 * showed and the permission prompt actually granted. */
export function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch {
    return false;
  }
}

/** Registers the dynamic content script for `origin`, or updates it in place if already registered —
 * idempotent, so `enableSite` can be called twice (or `reconcileSites` can re-assert an
 * already-correct registration) without Chrome rejecting the second call as a duplicate id. */
export async function registerSite(origin: string): Promise<void> {
  const spec = registrationSpec(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [spec.id] });
  if (existing.length > 0) await chrome.scripting.updateContentScripts([spec]);
  else await chrome.scripting.registerContentScripts([spec]);
}

/** Unregisters the dynamic content script for `origin`, if one is registered. */
export async function unregisterSite(origin: string): Promise<void> {
  const id = registrationId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

/** Startup reconciliation (design §4): the source of truth for "is this origin really enabled" is
 * chrome.permissions, not settings — the user (or Chrome) can revoke a host permission at any time
 * outside jev-duo's own UI. Drops any `origins` entry whose permission is gone, (re-)registers the
 * rest, and unregisters any leftover `jd-` registration for an origin no longer in the kept list (e.g.
 * left behind by a manual settings edit that skipped `disableSite`). Returns the possibly-narrowed,
 * sorted list to persist back to `settings.genericSites`. */
export async function reconcileSites(origins: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const origin of origins) {
    if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) kept.push(origin);
  }

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map((s) => s.id));
  const keptIds = new Set(kept.map(registrationId));

  const toRegister = kept.filter((origin) => !registeredIds.has(registrationId(origin))).map(registrationSpec);
  if (toRegister.length > 0) await chrome.scripting.registerContentScripts(toRegister);

  const toUnregister = registered.filter((s) => s.id.startsWith(ID_PREFIX) && !keptIds.has(s.id)).map((s) => s.id);
  if (toUnregister.length > 0) await chrome.scripting.unregisterContentScripts({ ids: toUnregister });

  return kept.sort();
}
