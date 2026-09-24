// `isBuiltInHost` is derived from manifest.json's static content_scripts entry, so these cases are
// really assertions about the SHIPPED manifest: a host is built in exactly when the extension already
// injects the content script there and the popup has nothing per-origin to offer. The popup used to
// carry its own regex of the same list, which is how `old.reddit.com` came to be labelled `built in`
// on a page jev-duo never ran on.

import { describe, expect, it } from 'vitest';
import manifest from '../../../src/extension/manifest.json';
import { isBuiltInHost } from '../../../src/extension/built-in-hosts';

describe('isBuiltInHost', () => {
  it.each(['x.com', 'twitter.com', 'www.reddit.com', 'news.ycombinator.com'])('%s is built in', (host) => {
    expect(isBuiltInHost(host)).toBe(true);
  });

  // old.reddit.com is not in content_scripts.matches, and (since the same fix wave) no adapter claims
  // it either: it is an ordinary site the user opts into per origin.
  it.each(['old.reddit.com', 'sh.reddit.com', 'reddit.com', 'mastodon.social', 'x.com.evil.example', 'notx.com'])(
    '%s is not built in',
    (host) => {
      expect(isBuiltInHost(host)).toBe(false);
    },
  );

  it('is case-insensitive about the hostname', () => {
    expect(isBuiltInHost('WWW.Reddit.COM')).toBe(true);
  });

  it('covers every host the manifest actually lists (no hand-maintained copy to drift)', () => {
    const hosts = manifest.content_scripts[0].matches.map((m) => new URL(m.replace(/\*$/, '')).hostname);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(isBuiltInHost(host)).toBe(true);
  });
});

// pdf.js's worker compiles one of the bundled `.wasm` decoders whenever a PDF carries an ICC colour
// profile or a JPX/JBIG2 image. Manifest V3's default content security policy refuses that compile
// and Chrome lists the refusal on the extension's Errors page (the first field test hit it), so the
// manifest must keep the one relaxation MV3 allows for WebAssembly — and nothing broader.
describe('manifest content security policy', () => {
  it('allows WebAssembly for extension pages and nothing broader', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|https?:/);
  });
});
