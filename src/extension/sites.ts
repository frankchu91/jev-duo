// Dynamic per-site content-script registration for the generic adapter (design §4). Isolated from
// background.ts because it is the only place in the service worker that touches
// chrome.scripting/chrome.permissions — the one call that lives elsewhere is the popup's
// `permissions.request`, which Chrome will only honour from inside a user-gesture handler. The three
// built-in sites are matched by the STATIC content_scripts entry in manifest.json and never go through
// here at all.

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

/** Unregisters the dynamic content script for `origin`, if one is registered, and hands the host
 * permission back. The permission release is best-effort: Chrome refuses to remove a permission the
 * manifest declares as required (which is how the e2e's patched manifest holds the fixture origin),
 * and a rejection there must not fail the disable — jev-duo is fully off the site either way, since
 * the script is gone and the origin is about to leave `settings.genericSites`. */
export async function unregisterSite(origin: string): Promise<void> {
  const id = registrationId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch (err) {
    console.error('jev-duo sites: releasing the host permission for', origin, 'failed', err);
  }
}

/** Startup reconciliation (design §4): the source of truth for "is this origin really enabled" is
 * chrome.permissions, not settings — the user (or Chrome) can revoke a host permission at any time
 * outside jev-duo's own UI. Drops any `origins` entry that is not a valid origin at all or whose
 * permission is gone, (re-)registers the rest, and unregisters any leftover `jd-` registration for an
 * origin no longer in the kept list (e.g. left behind by a manual settings edit that skipped
 * `disableSite`). Every per-origin step is isolated, so one failure narrows the list by one entry
 * instead of abandoning the whole reconciliation. Returns the possibly-narrowed, sorted list to
 * persist back to `settings.genericSites`. */
export async function reconcileSites(origins: string[]): Promise<string[]> {
  const kept: string[] = [];
  // Anything that is not an exact http(s) origin could never have been granted or registered through
  // `enableSite`, so it is dropped from settings outright rather than turned into a match pattern and
  // handed to Chrome — storage can hold anything an older version (or a hand edit) put there.
  for (const origin of origins.filter(isValidOrigin)) {
    // Per origin, so one failure can't abort the whole reconciliation: an origin whose permission we
    // cannot confirm is dropped (fail closed, same as a revoked one) and the loop carries on.
    try {
      if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) kept.push(origin);
    } catch (err) {
      console.error('jev-duo sites: permission check failed for', origin, err);
    }
  }

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map((s) => s.id));
  const keptIds = new Set(kept.map(registrationId));

  // Also one call per origin (rather than one batch): a batch that Chrome rejects for a single bad
  // entry would leave every other kept origin unregistered until the next service-worker start.
  for (const origin of kept) {
    if (registeredIds.has(registrationId(origin))) continue;
    try {
      await chrome.scripting.registerContentScripts([registrationSpec(origin)]);
    } catch (err) {
      // The origin keeps its permission and stays in settings: the next init() retries the
      // registration, and until then the site simply isn't judged.
      console.error('jev-duo sites: registering the content script for', origin, 'failed', err);
    }
  }

  const toUnregister = registered.filter((s) => s.id.startsWith(ID_PREFIX) && !keptIds.has(s.id)).map((s) => s.id);
  if (toUnregister.length > 0) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: toUnregister });
    } catch (err) {
      console.error('jev-duo sites: unregistering leftover content scripts failed', err);
    }
  }

  return kept.sort();
}
