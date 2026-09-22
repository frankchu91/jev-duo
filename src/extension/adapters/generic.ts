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
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// `\b` after none/hidden rejects "display:nonesuch"/"visibility:hiddenpopup" while still matching
// "display: none !important" (a boundary sits between "e" and " "/end-of-string either way).
const HIDDEN_STYLE = /display\s*:\s*none\b|visibility\s*:\s*hidden\b/i;
// Full-scan throttle (spec §3.5): a full document scan is the only way to discover a group other than
// the cached one — and, on a page with no cache at all, the only way to discover a first one — so it
// runs at most this often. Every call in between is either the cheap per-parent recount (a healthy
// cached parent) or nothing at all (no cache: the page had no qualifying feed the last time we looked,
// and a documentation page stays a documentation page). A detached or thinned cached parent bypasses
// the throttle entirely.
const FULL_SCAN_EVERY_CALLS = 20;
const FULL_SCAN_MIN_INTERVAL_MS = 5000;

function isHidden(el: Element): boolean {
  return (
    SKIPPED_TAGS.has(el.tagName) ||
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true' ||
    HIDDEN_STYLE.test(el.getAttribute('style') ?? '')
  );
}

/** Counts `visibleText` calls since the last `__generic.reset()`; read only by the unit test that
 * pins down "each element's text is walked once per scan" (see `scan`'s memo below). */
let textWalks = 0;

// Visible text (spec §3.2): `root`'s text minus script/style/noscript/template subtrees and minus any
// hidden/aria-hidden/inline-hidden element's subtree. Iterative (an explicit stack of {nodes, i} frames,
// not recursion) so an unusually deep chain of wrapper elements can't blow the call stack; each frame
// resumes exactly where it left off once the child it just pushed is fully drained, which visits nodes
// in the same document order recursion would. jsdom has no layout, so this is structural, not real
// computed visibility. Every reader of text — qualification, the median/tie-break in `scan`, and
// `extract`'s `text` field — goes through `collapsedText` below.
function visibleText(root: Element): string {
  textWalks += 1;
  if (isHidden(root)) return '';
  const parts: string[] = [];
  const stack: Array<{ nodes: NodeListOf<ChildNode>; i: number }> = [{ nodes: root.childNodes, i: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const child = frame.nodes[frame.i++];
    if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? '');
    else if (child.nodeType === Node.ELEMENT_NODE && !isHidden(child as Element)) {
      stack.push({ nodes: (child as Element).childNodes, i: 0 });
    }
  }
  return parts.join('');
}

function collapsedText(el: Element): string {
  return visibleText(el).replace(/\s+/g, ' ').trim();
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

// `ParentNode` doesn't statically expose `Node`'s `contains`, though every real Document/Element passed
// in has it — the cast below reflects that, not a runtime risk.
function contains(root: ParentNode, el: Element): boolean {
  return (root as unknown as Node).contains(el);
}

/** Direct children of `parent` sharing `signature`. The landmark rule is applied to `parent` itself by
 * both callers (see `scan` and `findPosts`): members are direct children, so they sit inside a landmark
 * exactly when their parent does, and one `closest` per parent replaces one per child. */
function siblingsOf(parent: Element, signature: string): Element[] {
  return [...parent.children].filter((c) => signatureOf(c) === signature);
}
function qualifying(members: Element[], textOf: (el: Element) => string = collapsedText): Element[] {
  return members.filter((el) => textOf(el).length >= MIN_TEXT);
}

interface Group { parent: Element; signature: string; members: Element[] }
// Spec §3.1-3: every element with >= MIN_SIBLINGS same-signature children is a candidate; it qualifies
// when >= MIN_SIBLINGS members clear MIN_TEXT and the median text length also clears it; the winner has
// the most qualifying members, ties going to the largest total text.
function scan(root: ParentNode): Group | undefined {
  let best: Group | undefined;
  let bestTotalText = -1;
  // One visible-text walk per element per scan: qualification, the median and the tie-break total all
  // read this memo instead of re-walking the same subtree three times, and `visibleText` is by far the
  // most expensive thing this module does. Local to the call, so the next scan still sees text the page
  // has changed in the meantime.
  const texts = new Map<Element, string>();
  const textOf = (el: Element): string => {
    const memo = texts.get(el);
    if (memo !== undefined) return memo;
    const text = collapsedText(el);
    texts.set(el, text);
    return text;
  };

  for (const parent of root.querySelectorAll('*')) {
    if (parent.children.length < MIN_SIBLINGS) continue;
    // One `closest` for the whole candidate group rather than one per child: every member is a direct
    // child of `parent`, so a landmarked parent is exactly a landmarked group. Applied here (not on
    // return) so a landmarked group can never accumulate enough members to qualify at all.
    if (isLandmarked(parent)) continue;
    const bySignature = new Map<string, Element[]>();
    for (const child of parent.children) {
      const sig = signatureOf(child);
      const list = bySignature.get(sig);
      if (list) list.push(child);
      else bySignature.set(sig, [child]);
    }
    for (const [signature, members] of bySignature) {
      if (members.length < MIN_SIBLINGS) continue;
      const qualified = qualifying(members, textOf);
      if (qualified.length < MIN_SIBLINGS) continue;
      if (median(members.map((el) => textOf(el).length)) < MIN_TEXT) continue;
      const totalText = qualified.reduce((sum, el) => sum + textOf(el).length, 0);
      // INVARIANT (spec §3.4): every member of a group is a DIRECT child of the same `parent`, so no
      // member can ever contain another — "outermost only" holds by construction here, which is why
      // nothing downstream filters for it.
      if (!best || qualified.length > best.members.length || (qualified.length === best.members.length && totalText > bestTotalText)) {
        best = { parent, signature, members: qualified };
        bestTotalText = totalText;
      }
    }
  }
  return best;
}
function authorElementOf(el: Element): Element | undefined {
  for (const sel of AUTHOR_SELECTORS) {
    const found = el.querySelector(sel);
    if (found && collapsedText(found)) return found;
  }
  return undefined;
}

let cache: { parent: Element; signature: string; count: number } | undefined;
let callsSinceFullScan = 0;
let lastFullScanAt = 0;

/** Test hook: an overridable clock (production always uses Date.now()), the visible-text walk counter,
 * and a way to clear the module's cache/throttle state between tests, so the full-scan throttle can be
 * driven deterministically instead of waiting on real wall-clock time. Not read or written by
 * content.ts or any production code path. */
export const __generic = {
  now: (): number => Date.now(),
  textWalks: (): number => textWalks,
  reset(): void {
    cache = undefined;
    callsSinceFullScan = 0;
    lastFullScanAt = 0;
    textWalks = 0;
  },
};

function adopt(found: Group | undefined): Element[] {
  if (!found) {
    cache = undefined;
    return [];
  }
  cache = { parent: found.parent, signature: found.signature, count: found.members.length };
  return found.members;
}

// A full scan is the only way to discover a group other than the cached one; every call site that
// performs one funnels through here so the throttle's counters always reset together.
function fullScan(root: ParentNode): Group | undefined {
  callsSinceFullScan = 0;
  lastFullScanAt = __generic.now();
  return scan(root);
}

/** Counts this call and reports whether a full scan is due. Fresh counters (`lastFullScanAt === 0`)
 * always report due, so the very first call on a page always scans. */
function fullScanDue(): boolean {
  callsSinceFullScan += 1;
  return callsSinceFullScan >= FULL_SCAN_EVERY_CALLS || __generic.now() - lastFullScanAt >= FULL_SCAN_MIN_INTERVAL_MS;
}

export const genericAdapter: Adapter = {
  platform: 'generic',
  matches: () => true,
  findPosts(root) {
    // The throttle is consulted BEFORE the cache branch: a page with no qualifying feed (a docs page,
    // an app shell, a feed that hasn't rendered yet) has no cached parent to recount cheaply, and used
    // to pay a full document scan on every single MutationObserver rescan for as long as the tab
    // stayed open. It now scans on the first call and thereafter at most once every 20 calls / 5s.
    const due = fullScanDue();
    if (!cache) return due ? adopt(fullScan(root)) : [];

    const usable = contains(root, cache.parent) && !isLandmarked(cache.parent);
    const own = usable ? qualifying(siblingsOf(cache.parent, cache.signature)) : [];
    // The cached group is a baseline worth protecting only while it's both attached (and still outside
    // any landmark) and still qualifies on its own (spec §3.5); once it's gone or has thinned below
    // MIN_SIBLINGS, a full scan runs right away (no throttle) and the next qualifying group found
    // anywhere is adopted regardless of size.
    if (!usable || own.length < MIN_SIBLINGS) return adopt(fullScan(root));

    // Healthy and attached: the cheap recount above already reflects this parent's current children, so
    // a full scan is only needed often enough to catch a dramatically larger competing group elsewhere.
    if (!due) {
      cache.count = own.length;
      return own;
    }

    // A DIFFERENT group at least twice the cached size displaces it, to avoid flapping.
    const found = fullScan(root);
    if (found && (found.parent !== cache.parent || found.signature !== cache.signature) && found.members.length >= cache.count * 2) {
      return adopt(found);
    }
    cache.count = own.length;
    return own;
  },
  extract(el) {
    const text = collapsedText(el).slice(0, TEXT_MAX);
    if (text.length < MIN_TEXT) return null;
    const id = `g:${fnv1a(location.host + text.slice(0, 500))}`;
    const authorEl = authorElementOf(el);
    const author = authorEl ? collapsedText(authorEl).slice(0, 60) : undefined;

    const httpLinks = [...el.querySelectorAll('a[href^="http"]')];
    // Any link INSIDE the author block (a profile card wrapping the handle in an <a>) is the author's,
    // not the post's — `contains` is true for the element itself, so this covers `a === authorEl` too.
    const linkEl = httpLinks.find((a) => !authorEl?.contains(a));
    const url = linkEl?.getAttribute('href') ?? location.href;
    const meta: ItemMeta = { hasLink: httpLinks.length > 0, hasMedia: !!el.querySelector('img, video, picture') };
    return { id, platform: 'generic', author, text, url, meta };
  },
  targets(el) {
    return [el];
  },
};
