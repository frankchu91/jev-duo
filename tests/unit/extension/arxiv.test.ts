// Design addendum 2026-09-23 §3.1: recognising an arXiv paper from its URL. Pure and DOM-free, and the
// ONLY parser of an arXiv URL in the extension — the popup gates its Read this paper button on it, the
// background builds the URLs it navigates to from it, and the reader page's hint link comes from it, so
// none of the three can drift. The `arxivHtmlTwin` cases below used to live in reader-page.test.ts
// against the reader's own copy of this parsing.

import { describe, expect, it } from 'vitest';
import { arxivHtmlTwin, arxivHtmlUrl, arxivId, arxivPdfUrl, isArxivId } from '../../../src/extension/arxiv';

const at = (href: string): URL => new URL(href);

describe('arxivId', () => {
  it.each([
    ['https://arxiv.org/pdf/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v7.pdf', '1706.03762v7'],
    ['https://arxiv.org/abs/2401.00001', '2401.00001'],
    // Old-style ids carry a slash of their own, which is why the id is "the rest of the path".
    ['https://arxiv.org/abs/hep-th/9901001', 'hep-th/9901001'],
    ['https://arxiv.org/pdf/hep-th/9901001v2.pdf', 'hep-th/9901001v2'],
  ])('%s -> %s', (href, id) => {
    expect(arxivId(at(href))).toBe(id);
  });

  // The HTML twin is the readable page itself: an ordinary web page, read by Read this page like any
  // other, so nothing ever needs its id (§3.1's matrix).
  it('is undefined for the HTML twin', () => {
    expect(arxivId(at('https://arxiv.org/html/2401.00001'))).toBeUndefined();
    expect(arxivId(at('https://arxiv.org/html/hep-th/9901001'))).toBeUndefined();
  });

  it('is not fooled by another host, or by a lookalike one', () => {
    expect(arxivId(at('https://example.com/pdf/1706.03762'))).toBeUndefined();
    expect(arxivId(at('https://arxiv.org.evil.example/pdf/1706.03762'))).toBeUndefined();
  });

  it('is not an arXiv paper page at all', () => {
    expect(arxivId(at('https://arxiv.org/list/cs'))).toBeUndefined();
    expect(arxivId(at('https://arxiv.org/'))).toBeUndefined();
  });

  it('needs an id after the prefix', () => {
    expect(arxivId(at('https://arxiv.org/pdf/'))).toBeUndefined();
    expect(arxivId(at('https://arxiv.org/abs/.pdf'))).toBeUndefined();
  });

  // Reads `hostname`, not `host`: the latter would be "arxiv.org:8443" here — the bug the reader page's
  // own gate was once regression-tested for, now in one place for both callers.
  it('ignores a port', () => {
    expect(arxivId(at('https://arxiv.org:8443/pdf/1706.03762'))).toBe('1706.03762');
  });
});

describe('arxivHtmlTwin', () => {
  it('rewrites a paper URL given as a string, which is how the reader page gets its ?src=', () => {
    expect(arxivHtmlTwin('https://arxiv.org/pdf/1706.03762')).toBe('https://arxiv.org/html/1706.03762');
    expect(arxivHtmlTwin('https://arxiv.org/pdf/1706.03762v7.pdf')).toBe('https://arxiv.org/html/1706.03762v7');
    expect(arxivHtmlTwin('https://arxiv.org/abs/1706.03762')).toBe('https://arxiv.org/html/1706.03762');
  });

  it('rejects everything arxivId does, and an unparseable URL besides', () => {
    expect(arxivHtmlTwin('https://example.com/pdf/1706.03762')).toBeUndefined();
    expect(arxivHtmlTwin('https://arxiv.org/pdf/')).toBeUndefined();
    expect(arxivHtmlTwin('not a url')).toBeUndefined();
    expect(arxivHtmlTwin('')).toBeUndefined();
  });
});

// The background navigates a tab to `https://arxiv.org/html/<id>`, and the id arrives in a message
// rather than from a URL it parsed itself — so it is checked before anything is navigated anywhere.
describe('isArxivId', () => {
  it.each(['1706.03762', '2401.00001v2', '1706.03762v7', 'hep-th/9901001', 'math.GT/0309136v2', '9901001'])('accepts %s', (id) => {
    expect(isArxivId(id)).toBe(true);
  });

  it.each(['', '..', 'evil', '../../etc/passwd', '1706.03762/../../x', 'https://evil.example/', '1706.03762?x=1', '1706.03762 '])(
    'rejects %j',
    (id) => {
      expect(isArxivId(id)).toBe(false);
    },
  );
});

describe('the two URLs one id resolves to', () => {
  it("are arXiv's own, with the id exactly as given", () => {
    expect(arxivHtmlUrl('hep-th/9901001')).toBe('https://arxiv.org/html/hep-th/9901001');
    expect(arxivPdfUrl('1706.03762v7')).toBe('https://arxiv.org/pdf/1706.03762v7');
  });
});
