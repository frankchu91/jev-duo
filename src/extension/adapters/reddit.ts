// reddit.com adapter (shreddit web components). Selectors confirmed 2026-09-21 from a Wayback capture
// of r/programming plus two open-source shreddit userscripts — see adapters/README.md. Ads render as
// the separate tag `shreddit-ad-post`, so the plain tag-name selector already excludes them; they are
// never judged.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

const BODY_MAX = 1500;
/** The hosts this adapter claims, and only these. The shipped manifest injects the content script on
 * `https://www.reddit.com/*` alone, and the shreddit selectors below describe that redesign; the apex
 * is here because it redirects there. `old.reddit.com` renders completely different markup, so it is
 * deliberately NOT claimed — `pickAdapter` falls through to the generic adapter, which the user opts
 * into per origin like any other site, instead of a built-in adapter that would find nothing there. */
const HOSTS = new Set(['www.reddit.com', 'reddit.com']);

function titleOf(el: Element): string | undefined {
  const attr = el.getAttribute('post-title');
  if (attr) return attr;
  return el.querySelector('a[slot="title"]')?.textContent?.trim() || undefined;
}

function bodyOf(el: Element): string | undefined {
  const body = el.querySelector('[slot="text-body"]')?.textContent?.trim();
  return body ? body.slice(0, BODY_MAX) : undefined;
}

function numberAttr(el: Element, name: string): number | undefined {
  const n = Number(el.getAttribute(name));
  return Number.isNaN(n) ? undefined : n;
}

export const redditAdapter: Adapter = {
  platform: 'reddit',

  matches(url) {
    return HOSTS.has(url.hostname.toLowerCase());
  },

  findPosts(root) {
    return [...root.querySelectorAll('shreddit-post')];
  },

  extract(el) {
    const title = titleOf(el);
    if (!title) return null;
    const body = bodyOf(el);
    const text = body ? `${title}\n\n${body}` : title;

    const rawId = el.getAttribute('id');
    const id = rawId ? `reddit:${rawId}` : `reddit:h${fnv1a(text)}`;
    const author = el.getAttribute('author') ?? undefined;
    const permalink = el.getAttribute('permalink');
    const url = permalink ? new URL(permalink, 'https://www.reddit.com').toString() : undefined;
    const postType = el.getAttribute('post-type') ?? '';

    const meta: ItemMeta = {
      hasLink: postType === 'link',
      hasMedia: postType === 'image' || postType === 'video' || postType === 'gallery',
      score: numberAttr(el, 'score'),
      comments: numberAttr(el, 'comment-count'),
    };

    return { id, platform: 'reddit', author, text, url, meta };
  },

  targets(el) {
    return [el];
  },
};
