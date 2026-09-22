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

/** Picks the adapter for `url`. The `jd-platform` query param (`x`/`reddit`/`hn`/`generic`) is a
 * test-only override for the e2e fixtures, served from localhost where the hostname can't tell sites
 * apart; an unrecognized value is ignored and falls through to the normal hostname match, which always
 * finds at least `genericAdapter`. */
export function pickAdapter(url: URL): Adapter | undefined {
  const override = url.searchParams.get(OVERRIDE_PARAM);
  const byOverride = override && ADAPTERS.find((a) => a.platform === override);
  return byOverride || ADAPTERS.find((a) => a.matches(url));
}

export { genericAdapter, hnAdapter, redditAdapter, xAdapter };
export type { Adapter, FoldHandlers } from './types';
