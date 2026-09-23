// @vitest-environment jsdom
//
// Unit coverage for reader.ts's PURE pieces only (status text, URL/src validation, arXiv detection,
// the render-to-DOM step) — importing the module here never touches chrome.*, fetch or pdf.js, because
// `wireUp()` only runs when `typeof chrome !== 'undefined'` (see reader.ts's guard at the bottom), and
// this file never installs a chrome stub. Everything else (loading, fetching, the permission flow, the
// judging loop) is exercised end-to-end in tests/e2e/reading.spec.ts, per the original design note: it
// is fetch, chrome.permissions and real pdf.js, which a jsdom test cannot exercise honestly.

import { describe, expect, it } from 'vitest';
import type { PdfDoc } from '../../../src/extension/reading/pdf-text';
import {
  arxivHtmlUrl,
  errMessage,
  isFetchableUrl,
  NO_TEXT_STATUS,
  NOT_A_PDF_URL_STATUS,
  parseErrorStatus,
  render,
} from '../../../src/extension/reader/reader';

/** Every block now carries the box its overlay is positioned from (§5.1). These cases are about the
 * page marks and the heading/passage split, so one arbitrary body-line box serves all of them; the
 * geometry itself is covered in pdf-text.test.ts. */
const BOX = { x: 72, y: 697.5, width: 215, height: 12.5 };

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

describe('render', () => {
  it('always marks page 1, even though it is the very first block (lastPage starts at 0, not 1)', () => {
    const container = document.createElement('main');
    const doc: PdfDoc = { title: 'One Page', blocks: [{ kind: 'passage', text: 'x'.repeat(50), page: 1, box: BOX }] };

    const passages = render(doc, container);

    const marks = [...container.querySelectorAll('.jd-page-mark')].map((m) => m.textContent);
    expect(marks).toEqual(['p. 1']);
    expect(passages).toHaveLength(1);
  });

  it('a page with no blocks of its own gets no mark: marks follow the blocks in doc order, not a 1..N loop', () => {
    const container = document.createElement('main');
    const doc: PdfDoc = {
      title: 'Skips a page',
      blocks: [
        { kind: 'passage', text: 'a'.repeat(50), page: 1, box: BOX },
        { kind: 'passage', text: 'b'.repeat(50), page: 3, box: BOX }, // page 2 contributed nothing (e.g. a figure-only page)
      ],
    };

    const passages = render(doc, container);

    const marks = [...container.querySelectorAll('.jd-page-mark')].map((m) => m.textContent);
    expect(marks).toEqual(['p. 1', 'p. 3']); // no "p. 2"
    expect(passages.map((p) => p.page)).toEqual([1, 3]);
  });

  it('renders the title as h1 and a heading block as h2.jd-heading, not a passage', () => {
    const container = document.createElement('main');
    const doc: PdfDoc = {
      title: 'Sample Paper',
      blocks: [
        { kind: 'heading', text: '1 Introduction', page: 1, box: BOX },
        { kind: 'passage', text: 'x'.repeat(50), page: 1, box: BOX },
      ],
    };

    const passages = render(doc, container);

    expect(container.querySelector('h1')?.textContent).toBe('Sample Paper');
    expect(container.querySelectorAll('h2.jd-heading')).toHaveLength(1);
    expect(container.querySelector('h2.jd-heading')?.textContent).toBe('1 Introduction');
    expect(passages).toHaveLength(1); // the heading is not a passage
  });

  it("a doc with no passage blocks (only headings) yields no passages — read()'s cue for the OCR status instead of mounting an empty reader", () => {
    const container = document.createElement('main');
    const doc: PdfDoc = { title: 'Scanned', blocks: [{ kind: 'heading', text: 'Title only', page: 1, box: BOX }] };

    const passages = render(doc, container);

    expect(passages).toHaveLength(0);
    // render() never touches panel machinery either way, but this is the actual observable contract
    // read() relies on: nothing named #jd-reader exists until mountReader is called, which the
    // `passages.length === 0` branch in read() skips entirely.
    expect(document.querySelector('#jd-reader')).toBeNull();
  });

  it('clears the container before rendering, so a re-read does not append to stale content', () => {
    const container = document.createElement('main');
    container.textContent = 'stale content from a previous read';
    const doc: PdfDoc = { title: 'T', blocks: [] };

    render(doc, container);

    expect(container.textContent).toBe('T'); // just the new h1, nothing left over
  });
});
