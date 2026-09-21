// reddit.com adapter (shreddit web components). Selectors confirmed 2026-09-21 from a Wayback capture
// of r/programming plus two open-source shreddit userscripts — see adapters/README.md. Ads render as
// the separate tag `shreddit-ad-post`, so the plain tag-name selector already excludes them; they are
// never judged.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

const BODY_MAX = 1500;

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
    return /(^|\.)reddit\.com$/i.test(url.hostname);
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
