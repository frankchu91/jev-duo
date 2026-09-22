// reddit.com adapter (shreddit web components). Selectors confirmed 2026-09-21 from a Wayback capture
// of r/programming plus two open-source shreddit userscripts — see adapters/README.md. Ads render as
// the separate tag `shreddit-ad-post`, so the plain tag-name selector already excludes them; they are
// never judged.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

const BODY_MAX = 1500;
/** The one host this adapter claims: exactly what the manifest's static `content_scripts` entry
 * injects on (`https://www.reddit.com/*`), which is also where the shreddit selectors below were read
 * off. Every other reddit host falls through to the generic adapter and its per-origin opt-in — the
 * apex because the extension is not injected there (it redirects to www anyway), `old.reddit.com`
 * because it renders completely different markup that this adapter would find nothing in. An adapter
 * claiming a host the manifest does not serve is a site the popup calls neither built in nor
 * enable-able. */
const HOSTS = new Set(['www.reddit.com']);

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
