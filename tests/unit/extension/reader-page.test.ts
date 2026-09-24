// @vitest-environment jsdom
//
// Unit coverage for reader.ts's PURE pieces only (status text, URL/src validation) — recognising an
// arXiv paper URL moved to src/extension/arxiv.ts, which the popup shares, and is covered there —
// importing the module here never touches chrome.*, fetch or pdf.js, because `wireUp()` only runs when
// `typeof chrome !== 'undefined'` (see reader.ts's guard at the bottom), and this file never installs a
// chrome stub. The page it BUILDS is covered in reader-pages.test.ts; everything that loads, fetches,
// asks for a permission or judges is exercised end-to-end in tests/e2e/reading.spec.ts.

import { describe, expect, it } from 'vitest';
import { errMessage, isFetchableUrl, NO_TEXT_STATUS, NOT_A_PDF_URL_STATUS, parseErrorStatus } from '../../../src/extension/reader/reader';

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
