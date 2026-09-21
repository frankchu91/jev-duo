// Shared contract for site adapters (x.ts, reddit.ts, hn.ts) and the fold UI's feedback callbacks.
// content.ts depends only on this file plus `pickAdapter` — it never talks to a concrete adapter type.

import type { Decision, Item } from '../../core/types';

/** Feedback hooks the fold UI calls when the user corrects a decision. content.ts wires these to
 * `send({type:'feedback', ...})`; ui/fold.ts itself never touches chrome.* or messages.ts. */
export interface FoldHandlers {
  onWrong(item: Item, decision: Decision): void;
  onHideThis(item: Item, decision: Decision): void;
}

export interface Adapter {
  platform: 'x' | 'reddit' | 'hn';
  /** Whether this adapter should run on `url` (hostname match; `pickAdapter` layers the `jd-platform`
   * test override on top of this). */
  matches(url: URL): boolean;
  /** Every candidate post element currently in `root`. Idempotent: calling it again after the DOM has
   * grown returns the previously-seen elements too (content.ts is what tracks "seen"), not just new
   * ones — so it is always safe to call on the whole document/root repeatedly. */
  findPosts(root: ParentNode): Element[];
  /** Pulls a judgeable `Item` out of a post element, or `null` when the post has nothing worth judging
   * yet (e.g. text not loaded). Must never throw on well-formed site DOM. */
  extract(el: Element): Item | null;
  /** The element(s) to fold/dim/badge for this post. Most adapters return `[el]`; HN returns the story
   * row plus its subtext and spacer rows so the whole three-row block folds together. */
  targets(el: Element): Element[];
  /** Optional: wrap the fold bar in whatever element the site's own markup accepts at that position,
   * and return the wrapper to insert instead. HN's feed is a `<table>`, where a `<div>` between two
   * `<tr>`s is not renderable — it returns a `<tr class="jd-bar-row"><td colspan="3">`. Adapters that
   * fold plain block elements omit this and the bar is inserted as is. */
  wrapBar?(bar: HTMLElement): HTMLElement;
}
