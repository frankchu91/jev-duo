// x.com / twitter.com adapter. Selectors confirmed 2026-09-21 against 7 open-source X extensions
// (control-panel-for-twitter, jev-lens, jevx, xtags, jev-x, vibecheck) — see adapters/README.md and
// docs/superpowers/research/selectors.md. X ships no stable per-post id in markup, so `extract` must
// derive one from the status permalink; a promoted or reposted-with-quote tweet still yields one Item.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

const HOSTS = /(^|\.)(x\.com|twitter\.com|pro\.x\.com)$/i;
const TEXT_MAX = 1000;

function outermostTweets(root: ParentNode): Element[] {
  return [...root.querySelectorAll('article[data-testid="tweet"]')].filter(
    (el) => !el.parentElement?.closest('article[data-testid="tweet"]'),
  );
}

/** The permalink anchor for `el`'s own status: prefers one that wraps a `<time>` (the canonical
 * timestamp/permalink), falling back to any `/status/` link so a differently-shaped tweet still yields
 * an id rather than falling all the way to the content hash. */
function statusHref(el: Element): string | undefined {
  const anchors = [...el.querySelectorAll('a[href*="/status/"]')];
  const withTime = anchors.find((a) => a.querySelector('time'));
  return (withTime ?? anchors[0])?.getAttribute('href') ?? undefined;
}

function authorOf(el: Element): string | undefined {
  const nameBlock = el.querySelector('[data-testid="User-Name"]');
  if (!nameBlock) return undefined;
  const handle = nameBlock.querySelector('[tabindex="-1"]');
  const raw = handle ? handle.textContent : (nameBlock.textContent ?? '').split('\n')[0];
  return raw?.trim() || undefined;
}

export const xAdapter: Adapter = {
  platform: 'x',

  matches(url) {
    return HOSTS.test(url.hostname);
  },

  findPosts(root) {
    return outermostTweets(root);
  },

  extract(el) {
    const texts = [...el.querySelectorAll('[data-testid="tweetText"]')];
    const primary = texts[0]?.textContent?.trim();
    if (!primary) return null;
    const quoted = texts[1]?.textContent?.trim();
    const text = (quoted ? `${primary}\n\n[quoted] ${quoted}` : primary).slice(0, TEXT_MAX);

    const href = statusHref(el);
    const digits = href?.match(/status\/(\d+)/)?.[1];
    const id = digits ? `x:${digits}` : `x:h${fnv1a(text)}`;

    const author = authorOf(el);
    const handle = author?.replace(/^@/, '');
    const url = digits && handle ? `https://x.com/${handle}/status/${digits}` : undefined;

    const meta: ItemMeta = {
      isPromoted: !!el.closest('[data-testid="placementTracking"]'),
      isReply: [...el.querySelectorAll('div[dir]')].some((d) => (d.textContent ?? '').trim().startsWith('Replying to')),
      hasMedia: !!el.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]'),
      hasLink: !!texts[0]?.querySelector('a[href^="http"]') || !!el.querySelector('[data-testid="card.wrapper"]'),
    };

    return { id, platform: 'x', author, text, url, meta };
  },

  targets(el) {
    return [el];
  },
};
