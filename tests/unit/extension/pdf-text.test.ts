import { describe, expect, it } from 'vitest';
import { pagesToBlocks, type PageText, type TextItem } from '../../../src/extension/reading/pdf-text';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** One drawn string at (x, y): pdf.js emits one item per Tj, with a width it measured itself. */
function item(str: string, x: number, y: number, size = 10, opts: { width?: number; rotated?: boolean } = {}): TextItem {
  return { str, x, y, size, width: opts.width ?? str.length * size * 0.5, rotated: opts.rotated ?? false };
}

function page(n: number, items: TextItem[]): PageText {
  return { page: n, width: PAGE_WIDTH, height: PAGE_HEIGHT, items };
}

const texts = (pages: PageText[], kind: 'heading' | 'passage'): string[] =>
  pagesToBlocks(pages, 'fallback').blocks.filter((b) => b.kind === kind).map((b) => b.text);

/** 43 characters, so a single line of it already clears the 40-char passage floor. */
const SENTENCE = 'A sentence with more than forty characters.';

describe('pagesToBlocks lines and blocks', () => {
  it('joins items on the same baseline in x order, collapsing whitespace', () => {
    const blocks = texts([page(1, [item('world.  ', 200, 700), item('Hello  ', 72, 700), item(SENTENCE, 72, 686)])], 'passage');
    expect(blocks[0]).toBe(`Hello world. ${SENTENCE}`);
  });

  it('starts a new block when the vertical gap exceeds 1.45 line sizes', () => {
    const blocks = texts(
      [page(1, [item(`First. ${SENTENCE}`, 72, 700), item('Still the first block.', 72, 686), item(`Second. ${SENTENCE}`, 72, 662)])],
      'passage',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(`First. ${SENTENCE} Still the first block.`);
    expect(blocks[1]).toBe(`Second. ${SENTENCE}`);
  });

  it('joins a hyphenated break and keeps a hyphen before a capital', () => {
    const joined = texts([page(1, [item(`${SENTENCE} trans-`, 72, 700), item('former layers follow.', 72, 686)])], 'passage');
    expect(joined[0]).toContain('transformer layers follow.');

    const kept = texts([page(1, [item(`${SENTENCE} re-`, 72, 700), item('Use is discouraged.', 72, 686)])], 'passage');
    expect(kept[0]).toContain('re- Use is discouraged.');
  });

  it('starts a new block when the size changes by more than a point', () => {
    const blocks = texts([page(1, [item(SENTENCE, 72, 700, 10), item(`${SENTENCE} but bigger`, 72, 686, 12)])], 'passage');
    expect(blocks).toHaveLength(2);
  });

  it('drops rotated items entirely', () => {
    const blocks = texts([page(1, [item(SENTENCE, 72, 700), item('WATERMARK DRAFT COPY DO NOT CIRCULATE', 300, 400, 30, { rotated: true })])], 'passage');
    expect(blocks.join(' ')).not.toContain('WATERMARK');
  });
});

describe('pagesToBlocks headings and kinds', () => {
  const body = [item(SENTENCE, 72, 650), item(`${SENTENCE} More body text.`, 72, 636)];

  it('calls a short line at 1.15x the body size a heading, and drops short non-heading lines', () => {
    const doc = pagesToBlocks([page(1, [item('1 Introduction', 72, 700, 14), ...body, item('ok', 72, 600)])], 'fallback');
    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual(['1 Introduction']);
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(1);
    expect(doc.blocks.map((b) => b.text)).not.toContain('ok');
  });

  it('takes the title from the largest page-1 block of at least eight characters', () => {
    const doc = pagesToBlocks(
      [
        page(1, [item('Sample Paper', 72, 740, 18), item('1 Introduction', 72, 700, 14), ...body]),
        page(2, [item('An Even Bigger Line On Page Two', 72, 740, 24)]),
      ],
      'fallback',
    );
    expect(doc.title).toBe('Sample Paper');
  });

  it('falls back to the given title when page one has no block long enough', () => {
    expect(pagesToBlocks([page(1, [item('Tiny', 72, 740, 18)])], 'my-file.pdf').title).toBe('my-file.pdf');
  });
});

describe('pagesToBlocks running headers and page numbers', () => {
  // Varies by a WORD, not a digit: normalize() maps digits to '#' for matching things like "Page 1 of
  // 9", so a per-page marker that is itself a digit (or, as originally written here, no marker at all
  // on the second line) collides across pages and is wrongly caught by the running-header filter.
  const PAGE_WORD = ['one', 'two', 'three'];
  const bodyOf = (n: number): TextItem[] => [
    item(`${SENTENCE} This body text is unique to the ${PAGE_WORD[n - 1]} page.`, 72, 650),
    item(`A second line unique to the ${PAGE_WORD[n - 1]} page.`, 72, 636),
  ];

  it('drops a header repeated at the same y on three pages, and the page numbers', () => {
    const pages = [1, 2, 3].map((n) => page(n, [item('Sample Paper - draft', 72, 770), ...bodyOf(n), item(String(n), 300, 40)]));
    const doc = pagesToBlocks(pages, 'fallback');
    const all = doc.blocks.map((b) => b.text).join('\n');
    expect(all).not.toContain('Sample Paper - draft');
    expect(doc.blocks.map((b) => b.text)).not.toContain('1');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(3);
  });

  it('normalises digits, so "Page 1 of 9" and "Page 2 of 9" count as the same running line', () => {
    const pages = [1, 2].map((n) => page(n, [item(`Page ${n} of 9`, 72, 770), ...bodyOf(n)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.map((b) => b.text).join('\n')).not.toContain('of 9');
  });

  it('keeps a line that appears on only one page of a two-page document', () => {
    // The floor of two pages: "half the pages" alone would be 1 here and would drop every line.
    const pages = [page(1, [item('Sample Paper', 72, 740, 18), ...bodyOf(1)]), page(2, bodyOf(2))];
    const doc = pagesToBlocks(pages, 'fallback');
    expect(doc.blocks.map((b) => b.text)).toContain('Sample Paper');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(2);
  });

  it('drops roman numerals as page numbers too', () => {
    const pages = [1, 2].map((n) => page(n, [...bodyOf(n), item(n === 1 ? 'iv' : 'v', 300, 40)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.map((b) => b.text).join('\n')).not.toContain('iv');
  });
});

describe('pagesToBlocks columns', () => {
  it('reads a two-column band left column first, between the full-width lines around it', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const doc = pagesToBlocks(
      [
        page(1, [
          full('A Two Column Paper', 740, 18),
          item(`LEFT. ${SENTENCE}`, 72, 700, 10, { width: 200 }),
          item('More of the left column here.', 72, 686, 10, { width: 200 }),
          item(`RIGHT. ${SENTENCE}`, 340, 700, 10, { width: 200 }),
          item('More of the right column here.', 340, 686, 10, { width: 200 }),
          full(`CAPTION. ${SENTENCE}`, 600),
        ]),
      ],
      'fallback',
    );
    const passages = doc.blocks.filter((b) => b.kind === 'passage').map((b) => b.text);
    expect(passages).toHaveLength(3);
    expect(passages[0].startsWith('LEFT.')).toBe(true);
    expect(passages[1].startsWith('RIGHT.')).toBe(true);
    expect(passages[2].startsWith('CAPTION.')).toBe(true);
    expect(doc.title).toBe('A Two Column Paper');
  });
});

describe('pagesToBlocks caps', () => {
  it('keeps the first 600 passages and counts no heading against the cap', () => {
    const items: TextItem[] = [item('A Heading Line', 72, 780, 18)];
    for (let i = 0; i < 700; i++) items.push(item(`Passage number ${i} with more than forty characters of text.`, 72, 760 - i * 40));
    const doc = pagesToBlocks([page(1, items)], 'fallback');
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(600);
    expect(doc.blocks.filter((b) => b.kind === 'heading')).toHaveLength(1);
  });
});
