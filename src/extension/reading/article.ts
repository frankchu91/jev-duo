// Reading mode's HTML source (design addendum §5): every paragraph that carries the document's own
// text, in document order, plus the title and lead the judge is given as context. No per-site
// selectors and no chrome.* — this runs inside whatever page the user clicked Read on, and inside
// jsdom in the tests. The generic feed adapter's question is "which blocks repeat?"; this one's is
// "which paragraphs are the document?", which is why they share only visible-text extraction.

import { LEAD_MAX, MAX_PASSAGES, MIN_PASSAGE_CHARS, TITLE_MAX, passageId, type DocContext, type Passage } from '../../core/reading';
import { collapsedText } from '../dom-text';

export interface ArticlePassage extends Passage {
  el: Element;
}

export interface Article {
  ctx: DocContext;
  passages: ArticlePassage[];
}

const MIN_ARTICLE_PASSAGES = 6;
const MIN_ARTICLE_CHARS = 1500;
/** Descend into a child only while it holds this much of its parent's candidate text (§5.2). */
const CONTAINER_SHARE = 0.8;

/** Everything a passage may not sit inside (§5.1) — chrome, controls, captions and code, all of which
 * are real text a reader is not reading *as the document*. Asked once per candidate with `closest`. */
const EXCLUDED_ANCESTORS =
  'nav, header, footer, aside, form, figure, figcaption, table, pre, code, [role="navigation"], [role="complementary"], [contenteditable]';

/** Each qualifying paragraph with its collapsed text, memoised together so the text walk (the most
 * expensive thing this file does) happens once per paragraph rather than once per reader. */
function candidatesWithText(doc: Document): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  for (const p of doc.body.querySelectorAll('p')) {
    if (p.closest(EXCLUDED_ANCESTORS)) continue;
    const text = collapsedText(p);
    if (text.length >= MIN_PASSAGE_CHARS) out.push([p, text]);
  }
  return out;
}

/** Every paragraph that could be a passage, container or not. §8.1's `no-article` result reports this
 * count, which is the difference between "this page is not an article" and "this page has no text". */
export function articleCandidates(doc: Document): Element[] {
  return candidatesWithText(doc).map(([el]) => el);
}

/** §5.2: start at `body` and keep descending while one child holds 80 % of the candidate text below
 * the current node. A blog whose comments hold a quarter of the text keeps the common parent — by
 * design: the reader is explicit, and comments are readable too. */
function containerOf(doc: Document, candidates: Array<[Element, string]>): Element {
  const mass = (node: Element): number => candidates.reduce((sum, [el, text]) => (node.contains(el) ? sum + text.length : sum), 0);
  let node: Element = doc.body;
  for (;;) {
    const total = mass(node);
    if (total === 0) return node;
    let best: Element | undefined;
    let bestMass = 0;
    for (const child of node.children) {
      const m = mass(child);
      if (m > bestMass) {
        best = child;
        bestMass = m;
      }
    }
    if (!best || bestMass < total * CONTAINER_SHARE) return node;
    node = best;
  }
}

/** §5.5. `source` reads the host window's location so a detached document (a DOMParser document in a
 * test) resolves to its own URL instead of whatever page happens to be global. */
function contextOf(doc: Document, container: Element, lead: string): DocContext {
  const h1 = container.querySelector('h1');
  const heading = h1 ? collapsedText(h1) : '';
  const description = (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: (heading || doc.title).slice(0, TITLE_MAX),
    lead: (description.length >= MIN_PASSAGE_CHARS ? description : lead).slice(0, LEAD_MAX),
    source: doc.defaultView?.location.href ?? doc.URL,
  };
}

/** The whole of §5. `undefined` means "this does not look like an article", which the caller shows as
 * a message rather than an empty reader — never a partial read. */
export function extractArticle(doc: Document): Article | undefined {
  const candidates = candidatesWithText(doc);
  if (candidates.length === 0) return undefined;

  const container = containerOf(doc, candidates);
  const inside = candidates.filter(([el]) => container.contains(el)).slice(0, MAX_PASSAGES);
  if (inside.length < MIN_ARTICLE_PASSAGES) return undefined;
  if (inside.reduce((sum, [, text]) => sum + text.length, 0) < MIN_ARTICLE_CHARS) return undefined;

  const passages: ArticlePassage[] = inside.map(([el, text], index) => ({ id: passageId(text), index, text, el }));
  return { ctx: contextOf(doc, container, passages[0].text), passages };
}
