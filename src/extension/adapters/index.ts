// Adapter registry and site selection. content.ts depends only on `pickAdapter` (plus the `Adapter`/
// `FoldHandlers` types) — it never imports a concrete adapter directly.

import { genericAdapter } from './generic';
import { hnAdapter } from './hn';
import { redditAdapter } from './reddit';
import type { Adapter } from './types';
import { xAdapter } from './x';

// `genericAdapter` is last and its `matches` is unconditionally true, so it is only ever reached once
// none of the three built-ins claim the URL — a real fallback, not a competing match.
const ADAPTERS: Adapter[] = [xAdapter, redditAdapter, hnAdapter, genericAdapter];
const OVERRIDE_PARAM = 'jd-platform';
/** The only hosts the `jd-platform` override is honoured on: the e2e fixture server, and nothing else.
 * A real site must never be able to pick its own adapter through a query string it controls — a link
 * to `https://x.com/home?jd-platform=generic` would otherwise swap the hand-written adapter for the
 * structural heuristic on a page the site itself laid out. */
const OVERRIDE_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Picks the adapter for `url`. The `jd-platform` query param (`x`/`reddit`/`hn`/`generic`) is a
 * test-only override for the e2e fixtures, served from localhost where the hostname can't tell sites
 * apart, and is read ONLY there (see OVERRIDE_HOSTS); an unrecognized value — or one on any other host
 * — is ignored and falls through to the normal hostname match, which always finds at least
 * `genericAdapter`. */
export function pickAdapter(url: URL): Adapter | undefined {
  const override = OVERRIDE_HOSTS.has(url.hostname) ? url.searchParams.get(OVERRIDE_PARAM) : null;
  const byOverride = override && ADAPTERS.find((a) => a.platform === override);
  return byOverride || ADAPTERS.find((a) => a.matches(url));
}

export { genericAdapter, hnAdapter, redditAdapter, xAdapter };
export type { Adapter, FoldHandlers } from './types';
