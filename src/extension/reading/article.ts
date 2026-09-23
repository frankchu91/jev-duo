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
 * are real text a reader is not reading *as the document*. Asked once per candidate with `closest`, and
 * again per candidate `h1` in `contextOf` so a site header's own heading can't become the title. */
const EXCLUDED_ANCESTORS =
  'nav, header, footer, aside, form, figure, figcaption, table, pre, code, [role="navigation"], [role="complementary"], [contenteditable]';

/** Each qualifying paragraph with its collapsed text, memoised together so the text walk (the most
 * expensive thing this file does) happens once per paragraph rather than once per reader. */
function candidatesWithText(body: Element): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  for (const p of body.querySelectorAll('p')) {
    if (p.closest(EXCLUDED_ANCESTORS)) continue;
    const text = collapsedText(p);
    if (text.length >= MIN_PASSAGE_CHARS) out.push([p, text]);
  }
  return out;
}

/** Both of §8.1's answers from ONE walk of the page: the article when the page is one, and how many
 * paragraphs were even considered — the difference between "this page is not an article" and "this
 * page has no text yet" — when it is not. Asking for them separately collapses the text of every
 * paragraph on the page twice, ~105 ms each on a 5,000-paragraph page, inside the page the user is
 * reading. A document with no `body` (an XML document, or a bare `new Document()`) has neither. */
export function readArticle(doc: Document): { article: Article | undefined; candidates: number } {
  if (!doc.body) return { article: undefined, candidates: 0 };
  const candidates = candidatesWithText(doc.body);
  return { article: articleOf(doc, doc.body, candidates), candidates: candidates.length };
}

/** Bottom-up, one pass: each candidate's text length is added to every ancestor between it and `body`
 * inclusive, so `containerOf`'s descent can read a node's mass with a single `Map.get` instead of
 * re-summing every candidate at every node it visits. O(candidates × depth) to build rather than
 * O(candidates × nodes visited) to query — the difference between milliseconds and seconds on a page
 * with several thousand paragraphs. Every candidate is a descendant of `body` by construction
 * (`candidatesWithText` only ever looks inside it), so stopping the walk at `body` is exhaustive. */
function massOf(body: Element, candidates: Array<[Element, string]>): Map<Element, number> {
  const mass = new Map<Element, number>();
  for (const [el, text] of candidates) {
    let node: Element | null = el;
    while (node) {
      mass.set(node, (mass.get(node) ?? 0) + text.length);
      if (node === body) break;
      node = node.parentElement;
    }
  }
  return mass;
}

/** §5.2: start at `body` and keep descending while one child holds 80 % of the candidate text below
 * the current node. A blog whose comments hold a quarter of the text keeps the common parent — by
 * design: the reader is explicit, and comments are readable too. */
function containerOf(body: Element, candidates: Array<[Element, string]>): Element {
  const mass = massOf(body, candidates);
  let node: Element = body;
  for (;;) {
    const total = mass.get(node) ?? 0;
    if (total === 0) return node;
    let best: Element | undefined;
    let bestMass = 0;
    for (const child of node.children) {
      const m = mass.get(child) ?? 0;
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
 * test) resolves to its own URL instead of whatever page happens to be global. The title comes from the
 * first `h1` in the container that does not itself sit inside an excluded ancestor (§5.1's selector,
 * reused): when the container stops the descent at `body` because comments or a sidebar hold too much
 * of the mass, a site's own `<header><h1>` is in `body` too, and document order alone would let it win
 * over the real heading just by coming first. */
function contextOf(doc: Document, container: Element, lead: string): DocContext {
  const h1 = [...container.querySelectorAll('h1')].find((el) => !el.closest(EXCLUDED_ANCESTORS));
  const heading = h1 ? collapsedText(h1) : '';
  const description = (doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: (heading || doc.title).slice(0, TITLE_MAX),
    lead: (description.length >= MIN_PASSAGE_CHARS ? description : lead).slice(0, LEAD_MAX),
    source: doc.defaultView?.location.href ?? doc.URL,
  };
}

/** The whole of §5. `undefined` means "this does not look like an article", which the caller shows as
 * a message rather than an empty reader — never a partial read. A document with no `body` (an XML
 * document, or a bare `new Document()`) is treated the same as one with no candidates. */
export function extractArticle(doc: Document): Article | undefined {
  return readArticle(doc).article;
}

/** §5.2 onwards, over candidates somebody else has already walked for. */
function articleOf(doc: Document, body: Element, candidates: Array<[Element, string]>): Article | undefined {
  if (candidates.length === 0) return undefined;

  const container = containerOf(body, candidates);
  const inside = candidates.filter(([el]) => container.contains(el)).slice(0, MAX_PASSAGES);
  if (inside.length < MIN_ARTICLE_PASSAGES) return undefined;
  if (inside.reduce((sum, [, text]) => sum + text.length, 0) < MIN_ARTICLE_CHARS) return undefined;

  const passages: ArticlePassage[] = inside.map(([el, text], index) => ({ id: passageId(text), index, text, el }));
  return { ctx: contextOf(doc, container, passages[0].text), passages };
}
