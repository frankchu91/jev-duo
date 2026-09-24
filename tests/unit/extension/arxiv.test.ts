// Design addendum 2026-09-23 §3.1: recognising an arXiv paper from its URL. Pure and DOM-free — the
// popup gates its Read this paper button on this and the background builds the two URLs it navigates
// to from it, so both sides agree on what "the same paper" means.

import { describe, expect, it } from 'vitest';
import { arxivHtmlUrl, arxivId, arxivPaperId, arxivPdfUrl } from '../../../src/extension/arxiv';

const at = (href: string): URL => new URL(href);

describe('arxivId', () => {
  it.each([
    ['https://arxiv.org/pdf/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v7.pdf', '1706.03762v7'],
    ['https://arxiv.org/abs/2401.00001', '2401.00001'],
    // Old-style ids carry a slash of their own, which is why the id is "the rest of the path".
    ['https://arxiv.org/html/hep-th/9901001', 'hep-th/9901001'],
    ['https://arxiv.org/pdf/hep-th/9901001v2.pdf', 'hep-th/9901001v2'],
  ])('%s -> %s', (href, id) => {
    expect(arxivId(at(href))).toBe(id);
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

  // Reads `hostname`, not `host`: the latter would be "arxiv.org:8443" here, and the reader page's own
  // arXiv gate already learned that lesson (tests/unit/extension/reader-page.test.ts).
  it('ignores a port', () => {
    expect(arxivId(at('https://arxiv.org:8443/pdf/1706.03762'))).toBe('1706.03762');
  });
});

describe('arxivPaperId', () => {
  it('is set for the two pages Read this paper replaces', () => {
    expect(arxivPaperId(at('https://arxiv.org/pdf/1706.03762v7.pdf'))).toBe('1706.03762v7');
    expect(arxivPaperId(at('https://arxiv.org/abs/2401.00001'))).toBe('2401.00001');
  });

  it('is undefined for the HTML twin, which is an ordinary web page', () => {
    expect(arxivPaperId(at('https://arxiv.org/html/2401.00001'))).toBeUndefined();
    expect(arxivId(at('https://arxiv.org/html/2401.00001'))).toBe('2401.00001'); // still an arXiv id
  });
});

describe('the two URLs one id resolves to', () => {
  it('are arXiv\'s own, with the id exactly as given', () => {
    expect(arxivHtmlUrl('hep-th/9901001')).toBe('https://arxiv.org/html/hep-th/9901001');
    expect(arxivPdfUrl('1706.03762v7')).toBe('https://arxiv.org/pdf/1706.03762v7');
  });
});
