// arXiv, the one site jev-duo knows anything about (design addendum 2026-09-23 §3). arXiv publishes an
// HTML version of nearly every paper — even hep-th/9901001 has one — and that page has real paragraphs,
// which a PDF only ever has glyph positions for. So **Read this paper** sends the tab to the HTML twin
// and runs the ordinary in-page reader there: no extension UI, the paper on its own page.
//
// This is the ONE place that parses an arXiv URL. The popup gates its button on it, the background
// builds the URLs it navigates to from it, and the reader page's hint link comes from it too — so none
// of the three can drift from the others. Pure and DOM-free; nothing here touches chrome.*.
//
// No host permission is involved anywhere. The popup's click grants `activeTab` for that tab, and Chrome
// keeps that grant across a SAME-ORIGIN navigation ("invokes the extension on https://example.com and
// then navigates to https://example.com/foo, the extension will continue to have access"), which
// arxiv.org -> arxiv.org is.

/** The two arXiv pages **Read this paper** replaces. `/html/<id>` is deliberately absent: that page is
 * the readable twin itself — an ordinary web page, read by **Read this page** like any other (§3.1's
 * matrix) — so nothing ever needs its id. */
const PAPER_PREFIXES = ['/pdf/', '/abs/'] as const;

/** What an arXiv identifier can look like: new-style `2401.00001`, `1706.03762v7`, and old-style
 * `hep-th/9901001` or `math.GT/0309136v2`. Anything else is not something to navigate a tab to. */
const ID_PATTERN = /^(?:[a-z-]+(?:\.[A-Z]{2})?\/)?\d{4,7}(?:\.\d{4,5})?(?:v\d+)?$/i;

/** The paper id in an arXiv `/pdf/` or `/abs/` URL; undefined for anything else, including the
 * `/html/` twin. Reads `hostname` rather than `host`, which would carry a port and make
 * `arxiv.org:8443` a different site than arxiv.org. */
export function arxivId(url: URL): string | undefined {
  if (url.hostname !== 'arxiv.org') return undefined;
  const prefix = PAPER_PREFIXES.find((p) => url.pathname.startsWith(p));
  if (prefix === undefined) return undefined;
  // Everything after the prefix, minus a trailing `.pdf`: new-style `2401.00001v2` and old-style
  // `hep-th/9901001` (which carries a slash of its own) both come through whole.
  const id = url.pathname.slice(prefix.length).replace(/\.pdf$/i, '');
  return id === '' ? undefined : id;
}

/** The same, for a URL that is still a string — the reader page's `?src=`, which is whatever was put in
 * the query. An unparseable one is rejected rather than thrown. */
export function arxivHtmlTwin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const id = arxivId(url);
  return id === undefined ? undefined : arxivHtmlUrl(id);
}

/** Whether `id` is shaped like an arXiv identifier at all. The background checks this before it
 * navigates a tab: `arxivId` derives ids from the URL the user is already on, but a `readArxiv` message
 * carries whatever it carries, and "navigate this tab to https://arxiv.org/html/<anything>" is not
 * something to do on trust. */
export function isArxivId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export const arxivHtmlUrl = (id: string): string => `https://arxiv.org/html/${id}`;
export const arxivPdfUrl = (id: string): string => `https://arxiv.org/pdf/${id}`;
