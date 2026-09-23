// @vitest-environment jsdom
//
// Unit coverage for reader.ts's PURE pieces only (status text, URL/src validation, arXiv detection) —
// importing the module here never touches chrome.*, fetch or pdf.js, because `wireUp()` only runs when
// `typeof chrome !== 'undefined'` (see reader.ts's guard at the bottom), and this file never installs a
// chrome stub. The page it BUILDS is covered in reader-pages.test.ts; everything that loads, fetches,
// asks for a permission or judges is exercised end-to-end in tests/e2e/reading.spec.ts.

import { describe, expect, it } from 'vitest';
import { arxivHtmlUrl, errMessage, isFetchableUrl, NO_TEXT_STATUS, NOT_A_PDF_URL_STATUS, parseErrorStatus } from '../../../src/extension/reader/reader';

describe('arxivHtmlUrl', () => {
  it('a bare arXiv id becomes the HTML twin', () => {
    expect(arxivHtmlUrl('https://arxiv.org/pdf/1706.03762')).toBe('https://arxiv.org/html/1706.03762');
  });

  it('a versioned id with a .pdf suffix keeps its version and drops the suffix', () => {
    expect(arxivHtmlUrl('https://arxiv.org/pdf/1706.03762v7.pdf')).toBe('https://arxiv.org/html/1706.03762v7');
  });

  it('a non-arXiv host is not rewritten', () => {
    expect(arxivHtmlUrl('https://example.com/pdf/1706.03762')).toBeUndefined();
  });

  it('/pdf/ alone has no id to rewrite', () => {
    expect(arxivHtmlUrl('https://arxiv.org/pdf/')).toBeUndefined();
  });

  it('an arXiv URL outside /pdf/ is not a PDF link at all', () => {
    expect(arxivHtmlUrl('https://arxiv.org/abs/1706.03762')).toBeUndefined();
  });

  it('an unparseable URL is rejected rather than thrown', () => {
    expect(arxivHtmlUrl('not a url')).toBeUndefined();
  });

  it('a lookalike subdomain is not arxiv.org itself', () => {
    expect(arxivHtmlUrl('https://arxiv.org.evil.example/pdf/1706.03762')).toBeUndefined();
  });

  it('reads hostname, not host: an explicit port does not defeat the match (mirrors the popup gate)', () => {
    // .host would be "arxiv.org:8443", which !== 'arxiv.org' — the bug this regression-tests for.
    expect(arxivHtmlUrl('https://arxiv.org:8443/pdf/1706.03762')).toBe('https://arxiv.org/html/1706.03762');
  });
});

describe('isFetchableUrl', () => {
  it.each([
    ['http://example.test/paper.pdf', true],
    ['https://example.test/paper.pdf', true],
    ['', false], // an empty ?src= would otherwise re-fetch this very page
    ['file:///Users/me/paper.pdf', false], // .origin on a file: URL is the literal string "null"
    ['paper.pdf', false], // relative — no base to resolve against
    ['ftp://example.test/paper.pdf', false],
    ['not a url at all', false],
  ])('isFetchableUrl(%j) is %s', (value, expected) => {
    expect(isFetchableUrl(value)).toBe(expected);
  });
});

describe('parse-failure status text', () => {
  it('errMessage reads an Error message', () => {
    expect(errMessage(new Error('bad xref table'))).toBe('bad xref table');
  });

  it('errMessage stringifies a non-Error rejection', () => {
    expect(errMessage('oops')).toBe('oops');
  });

  it('parseErrorStatus wraps it in the exact copy string', () => {
    expect(parseErrorStatus(new Error('bad xref table'))).toBe("can't read this PDF: bad xref table");
    expect(parseErrorStatus('oops')).toBe("can't read this PDF: oops");
  });

  it('NOT_A_PDF_URL_STATUS is the exact copy for an empty/non-http(s) src', () => {
    expect(NOT_A_PDF_URL_STATUS).toBe('not a PDF URL');
  });

  it('NO_TEXT_STATUS is the exact OCR copy', () => {
    expect(NO_TEXT_STATUS).toBe('no text found in this PDF (scanned pages need OCR, which jev-duo does not do)');
  });
});
