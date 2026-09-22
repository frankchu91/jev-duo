// Generic feed adapter: the largest group of structurally repeated sibling blocks becomes the feed.
// `pickAdapter` reaches this only once the three built-in adapters fail to match, so `matches` is
// always true — see docs/superpowers/specs/2026-09-21-generic-sites-design.md §3. Pure DOM: no chrome.*.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

const MIN_SIBLINGS = 4;
const MIN_TEXT = 40;
const SIG_CLASSES = 3;
const CLASS_MAX_LEN = 24;
const TEXT_MAX = 2000;
const LANDMARKS = 'nav, header, footer, aside, form';
const AUTHOR_SELECTORS = ['[rel="author"]', 'a[href*="/@"]', '[class*="author" i]', '[data-author]'];

function collapsedText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// tagName + up to 3 sorted classes; a class with a digit, or longer than 24 chars, is dropped as
// generated (a thread id, a CSS-module hash) so per-instance classes don't fragment one signature.
function signatureOf(el: Element): string {
  const classes = [...el.classList].filter((c) => c.length <= CLASS_MAX_LEN && !/\d/.test(c)).sort();
  return `${el.tagName}|${classes.slice(0, SIG_CLASSES).join('.')}`;
}

function isLandmarked(el: Element): boolean {
  return !!el.closest(LANDMARKS);
}
function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// `ParentNode` doesn't statically expose `Node`'s `contains`/`ownerDocument`, though every real
// Document/Element passed in has them — the casts below reflect that, not a runtime risk.
function contains(root: ParentNode, el: Element): boolean {
  return (root as unknown as Node).contains(el);
}
// Same Document as `el`? Scopes the flapping guard in `findPosts` to one page: a cached count from an
// unrelated document (only between independent test fixtures — a real navigation reloads this module
// fresh) must never suppress a first scan of a new page.
function sameDocument(root: ParentNode, el: Element): boolean {
  const node = root as unknown as Node;
  return (node.nodeType === 9 ? node : node.ownerDocument) === el.ownerDocument;
}

// Direct children of `parent` sharing `signature`, dropping any inside a landmark — applied here (not
// just on return) so a landmarked group can never accumulate enough members to qualify at all.
function siblingsOf(parent: Element, signature: string): Element[] {
  return [...parent.children].filter((c) => !isLandmarked(c) && signatureOf(c) === signature);
}
function qualifying(members: Element[]): Element[] {
  return members.filter((el) => collapsedText(el).length >= MIN_TEXT);
}

interface Group { parent: Element; signature: string; members: Element[] }
// Spec §3.1-3: every element with >= MIN_SIBLINGS same-signature children is a candidate; it qualifies
// when >= MIN_SIBLINGS members clear MIN_TEXT and the median text length also clears it; the winner has
// the most qualifying members, ties going to the largest total text.
function scan(root: ParentNode): Group | undefined {
  let best: Group | undefined;
  let bestTotalText = -1;
  for (const parent of root.querySelectorAll('*')) {
    if (parent.children.length < MIN_SIBLINGS) continue;
    const bySignature = new Map<string, Element[]>();
    for (const child of parent.children) {
      if (isLandmarked(child)) continue;
      const sig = signatureOf(child);
      const list = bySignature.get(sig);
      if (list) list.push(child);
      else bySignature.set(sig, [child]);
    }
    for (const [signature, members] of bySignature) {
      if (members.length < MIN_SIBLINGS) continue;
      const qualified = qualifying(members);
      if (qualified.length < MIN_SIBLINGS) continue;
      if (median(members.map((el) => collapsedText(el).length)) < MIN_TEXT) continue;
      const totalText = qualified.reduce((sum, el) => sum + collapsedText(el).length, 0);
      if (!best || qualified.length > best.members.length || (qualified.length === best.members.length && totalText > bestTotalText)) {
        best = { parent, signature, members: qualified };
        bestTotalText = totalText;
      }
    }
  }
  return best;
}
// Excludes any member contained inside another (direct siblings never nest; mirrors x.ts's outermostTweets).
function outermost(members: Element[]): Element[] {
  return members.filter((el) => !members.some((other) => other !== el && other.contains(el)));
}
function authorElementOf(el: Element): Element | undefined {
  for (const sel of AUTHOR_SELECTORS) {
    const found = el.querySelector(sel);
    if (found && collapsedText(found)) return found;
  }
  return undefined;
}
let cache: { parent: Element; signature: string; count: number } | undefined;

export const genericAdapter: Adapter = {
  platform: 'generic',
  matches: () => true,
  findPosts(root) {
    if (cache && contains(root, cache.parent)) {
      const members = qualifying(siblingsOf(cache.parent, cache.signature));
      if (members.length === 0) {
        cache = undefined;
        return [];
      }
      cache.count = members.length;
      return outermost(members);
    }

    const priorCount = cache && sameDocument(root, cache.parent) ? cache.count : 0;
    cache = undefined;
    const found = scan(root);
    if (!found) return [];
    // Replace the cached group only when the new one is at least twice its size, to avoid flapping.
    if (priorCount > 0 && found.members.length < priorCount * 2) return [];

    cache = { parent: found.parent, signature: found.signature, count: found.members.length };
    return outermost(found.members);
  },
  extract(el) {
    const text = collapsedText(el).slice(0, TEXT_MAX);
    if (text.length < MIN_TEXT) return null;
    const id = `g:${fnv1a(location.host + text.slice(0, 500))}`;
    const authorEl = authorElementOf(el);
    const author = authorEl ? collapsedText(authorEl).slice(0, 60) : undefined;

    const httpLinks = [...el.querySelectorAll('a[href^="http"]')];
    const linkEl = httpLinks.find((a) => a !== authorEl);
    const url = linkEl?.getAttribute('href') ?? location.href;
    const meta: ItemMeta = { hasLink: httpLinks.length > 0, hasMedia: !!el.querySelector('img, video, picture') };
    return { id, platform: 'generic', author, text, url, meta };
  },
  targets(el) {
    return [el];
  },
};
