// arXiv, the one site jev-duo knows anything about (design addendum 2026-09-23 §3). arXiv publishes an
// HTML version of nearly every paper — even hep-th/9901001 has one — and that page has real paragraphs,
// which a PDF only ever has glyph positions for. So **Read this paper** sends the tab to the HTML twin
// and runs the ordinary in-page reader there: no extension UI, the paper on its own page.
//
// Pure and DOM-free: the popup gates its button on this, the background builds the URLs it navigates to
// from it, and neither has to agree with the other by convention. Nothing here touches chrome.*.
//
// No host permission is involved anywhere. The popup's click grants `activeTab` for that tab, and Chrome
// keeps that grant across a SAME-ORIGIN navigation ("invokes the extension on https://example.com and
// then navigates to https://example.com/foo, the extension will continue to have access"), which
// arxiv.org -> arxiv.org is.

/** The three arXiv paths that name one paper. `/html/` is the twin itself — an ordinary web page. */
const PREFIXES = ['/pdf/', '/abs/', '/html/'] as const;

/** Reads `hostname` rather than `host`, which would carry a port and make `arxiv.org:8443` a different
 * site than arxiv.org — the same gate, and the same reason, as the reader page's `arxivHtmlUrl`. */
function idAfter(url: URL, prefixes: readonly string[]): string | undefined {
  if (url.hostname !== 'arxiv.org') return undefined;
  const prefix = prefixes.find((p) => url.pathname.startsWith(p));
  if (prefix === undefined) return undefined;
  // Everything after the prefix, minus a trailing `.pdf`: new-style `2401.00001v2` and old-style
  // `hep-th/9901001` (which carries a slash of its own) both come through whole.
  const id = url.pathname.slice(prefix.length).replace(/\.pdf$/i, '');
  return id === '' ? undefined : id;
}

/** The paper id in an arXiv `/pdf/`, `/abs/` or `/html/` URL; undefined for anything else. */
export function arxivId(url: URL): string | undefined {
  return idAfter(url, PREFIXES);
}

/** The same, restricted to the two pages **Read this paper** offers to replace. An `/html/` page is
 * already the readable one, so there it is **Read this page** that does the work, unchanged. */
export function arxivPaperId(url: URL): string | undefined {
  return idAfter(url, ['/pdf/', '/abs/']);
}

export const arxivHtmlUrl = (id: string): string => `https://arxiv.org/html/${id}`;
export const arxivPdfUrl = (id: string): string => `https://arxiv.org/pdf/${id}`;
