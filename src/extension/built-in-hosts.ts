// Which hosts ship with the extension, derived from the one place that decides it: the static
// `content_scripts` entry in manifest.json. The popup's This-site section uses this to say `built in`
// (no permission to grant, the script is already there) instead of offering a per-origin opt-in, and a
// hand-maintained regex that drifted from the manifest would be wrong in exactly the way the user
// notices — a site labelled `built in` that jev-duo never actually runs on. Importing the manifest
// (resolveJsonModule) makes drift impossible.

import manifest from './manifest.json';

/** `https://www.reddit.com/*` -> `www.reddit.com`. Anything that isn't a `<scheme>://<host>/<path>`
 * match pattern (e.g. `<all_urls>`) yields undefined and is ignored. */
function hostOf(pattern: string): string | undefined {
  return /^[a-z*]+:\/\/([^/]+)\//i.exec(pattern)?.[1].toLowerCase();
}

/** Each entry is either an exact host (`x.com`) or Chrome's `*.example.com` wildcard, which matches
 * the domain itself and any subdomain. The shipped manifest uses only exact hosts today. */
const BUILT_IN_HOSTS: string[] = manifest.content_scripts[0].matches.map(hostOf).filter((h): h is string => h !== undefined);

/** True when `hostname` is covered by the manifest's static content_scripts entry — i.e. jev-duo
 * already runs there and there is nothing per-origin to grant. Note that this is narrower than the
 * built-in adapters' own `matches`: `old.reddit.com` is not built in (no adapter claims it either),
 * and neither is a subdomain the manifest doesn't list. */
export function isBuiltInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BUILT_IN_HOSTS.some((entry) => {
    if (!entry.startsWith('*.')) return host === entry;
    const base = entry.slice(2);
    return host === base || host.endsWith(`.${base}`);
  });
}
