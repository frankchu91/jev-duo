import { describe, expect, it } from 'vitest';
import { displaySize, pagesToBlocks, toPercentBox, type Box, type PageText, type TextItem } from '../../../src/extension/reading/pdf-text';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** One drawn string at (x, y): pdf.js emits one item per Tj, with a width it measured itself. */
function item(str: string, x: number, y: number, size = 10, opts: { width?: number; rotated?: boolean } = {}): TextItem {
  return { str, x, y, size, width: opts.width ?? str.length * size * 0.5, rotated: opts.rotated ?? false };
}

/** A page of `items`. `origin` is `page.view[0]`/`[1]` — 0 for anything synthetic, non-zero only for a
 * cropped page, which the last toPercentBox case below covers directly. */
function page(n: number, items: TextItem[], origin: { x: number; y: number } = { x: 0, y: 0 }): PageText {
  return { page: n, width: PAGE_WIDTH, height: PAGE_HEIGHT, originX: origin.x, originY: origin.y, rotation: 0, items };
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

  // Final wave: the 3 pt tolerance is a WINDOW around each line's y, not a rounded bucket — 770 and
  // 768 are 2 pt apart and must match even though `Math.round(y / 3)` puts them in different buckets.
  // The text is deliberately over 40 characters so an undropped copy shows up as a passage.
  const DRIFTING = 'Confidential draft of a running header line';

  it('drops a header that drifts within the 3pt tolerance across pages', () => {
    const ys = [770, 768, 769];
    const pages = [1, 2, 3].map((n) => page(n, [item(DRIFTING, 72, ys[n - 1]), ...bodyOf(n)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.map((b) => b.text)).not.toContain(DRIFTING);
  });

  it('keeps a repeated line whose y drifts further than the tolerance', () => {
    const ys = [770, 766, 762];
    const pages = [1, 2, 3].map((n) => page(n, [item(DRIFTING, 72, ys[n - 1]), ...bodyOf(n)]));
    expect(pagesToBlocks(pages, 'fallback').blocks.filter((b) => b.text === DRIFTING)).toHaveLength(3);
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

// Final wave, IMPORTANT: `runningFilter` used to re-scan its whole equal-normalized-text group once
// per line in it (`for (const anchor of group) group.filter(...)`), which is O(n²) in the size of the
// largest group. A table whose rows all normalize to the same shape (digits -> '#') puts the entire
// document in one group: 12,000 lines took 381 ms on the reader page's main thread.
describe('pagesToBlocks performance', () => {
  it('filters 12,000 same-shape lines across 120 pages in under 100ms', () => {
    // Fixed-width numbers on purpose: normalize() maps each digit to '#', so every one of these 12,000
    // rows collapses onto ONE key and the filter faces its worst case.
    const pages = Array.from({ length: 120 }, (_, p) =>
      page(
        p + 1,
        Array.from({ length: 100 }, (_, i) => item(`Row ${String(i).padStart(3, '0')} 45.6 78 900 1234 5678 9012`, 72, 700 - i * 6)),
      ),
    );

    const start = performance.now();
    const doc = pagesToBlocks(pages, 'fallback');
    const elapsed = performance.now() - start;

    // Every row sits at the same y on all 120 pages, so the rule drops all of them — the same answer
    // the quadratic version gave, which is what makes this an equivalence check and not just a clock.
    expect(doc.blocks).toHaveLength(0);
    expect(doc.title).toBe('fallback');
    expect(elapsed).toBeLessThan(100);
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

  // Final wave, M7: passages were capped and headings were not, so a 300-slide deck — every slide a
  // handful of short lines in a big font — rendered thousands of <h2> into the reader page.
  it('keeps the first 600 headings too, counted separately from the passages', () => {
    // One "slide" per page: a big short title line, and a body line so the body size stays 10 pt. The
    // per-slide marker is letters, not a number: normalize() maps digits to '#', so numbered titles at
    // the same y on 700 pages would all be dropped as running headers before any cap was reached.
    const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
    const mark = (i: number): string => `${LETTERS[i % 26]}${LETTERS[Math.floor(i / 26) % 26]}${LETTERS[Math.floor(i / 676) % 26]}`;
    const pages = Array.from({ length: 700 }, (_, i) =>
      page(i + 1, [item(`Slide title ${mark(i)}`, 72, 700, 18), item(`${SENTENCE} Body of slide ${mark(i)}.`, 72, 600)]),
    );
    const doc = pagesToBlocks(pages, 'fallback');
    expect(doc.blocks.filter((b) => b.kind === 'heading')).toHaveLength(600);
    expect(doc.blocks.filter((b) => b.kind === 'passage')).toHaveLength(600);
    expect(doc.blocks).toHaveLength(1200);
  });
});

// --- Design addendum 2026-09-23 §5.1: where each block SITS, so the reader can draw on the page ---

describe('pagesToBlocks boxes', () => {
  const boxes = (pages: PageText[], kind: 'heading' | 'passage'): Box[] =>
    pagesToBlocks(pages, 'fallback').blocks.filter((b) => b.kind === kind).map((b) => b.box);

  it("a single line's box is one em above the baseline and a quarter em below it", () => {
    // `item` measures width as chars x size x 0.5, so this 43-character line is 215 pt wide.
    expect(boxes([page(1, [item(SENTENCE, 72, 700, 10)])], 'passage')).toEqual([{ x: 72, y: 697.5, width: 215, height: 12.5 }]);
  });

  it("a three-line block's box is the union of its lines' boxes", () => {
    const lines = [
      item(SENTENCE, 72, 700, 10), // 43 chars -> right 287
      item('Second line here.', 72, 686, 10), // 17 chars -> right 157
      item('A third line that is longer than the first one.', 72, 672, 10), // 47 chars -> right 307
    ];

    // x/width from the widest line, y from the lowest baseline's descent, top from the highest ascent.
    expect(boxes([page(1, lines)], 'passage')).toEqual([{ x: 72, y: 669.5, width: 235, height: 40.5 }]);
  });

  it('a two-column band gives the two blocks disjoint boxes', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const pages = [
      page(1, [
        full('A Two Column Paper', 740, 18),
        item(`LEFT. ${SENTENCE}`, 72, 700, 10, { width: 200 }),
        item('More of the left column here.', 72, 686, 10, { width: 200 }),
        item(`RIGHT. ${SENTENCE}`, 340, 700, 10, { width: 200 }),
        item('More of the right column here.', 340, 686, 10, { width: 200 }),
      ]),
    ];

    const [left, right] = boxes(pages, 'passage');
    expect(left).toEqual({ x: 72, y: 683.5, width: 200, height: 26.5 });
    expect(right).toEqual({ x: 340, y: 683.5, width: 200, height: 26.5 });
    expect(left.x + left.width).toBeLessThanOrEqual(right.x); // no overlap: two overlays, two columns
  });

  it('headings carry boxes too', () => {
    const full = (str: string, y: number, size = 10): TextItem => item(str, 72, y, size, { width: 468 });
    const pages = [page(1, [full('A Two Column Paper', 740, 18), item(SENTENCE, 72, 700, 10), item('More body text here.', 72, 686, 10)])];

    expect(boxes(pages, 'heading')).toEqual([{ x: 72, y: 735.5, width: 468, height: 22.5 }]);
  });
});

describe('toPercentBox', () => {
  const LETTER = { width: 612, height: 792, originX: 0, originY: 0, rotation: 0 as const };

  it('projects a box on a letter page whose origin is (0, 0)', () => {
    expect(toPercentBox({ x: 61.2, y: 396, width: 306, height: 79.2 }, LETTER)).toEqual({
      left: '10.000%',
      top: '40.000%',
      width: '50.000%',
      height: '10.000%',
    });
  });

  it("subtracts a cropped page's origin from both axes", () => {
    // The same box, shifted by the origin: the same place on the page.
    expect(toPercentBox({ x: 71.2, y: 416, width: 306, height: 79.2 }, { width: 612, height: 792, originX: 10, originY: 20, rotation: 0 })).toEqual({
      left: '10.000%',
      top: '40.000%',
      width: '50.000%',
      height: '10.000%',
    });
  });

  it('flips the y axis: a box near the top of the page has a small `top`', () => {
    expect(toPercentBox({ x: 0, y: 752.4, width: 612, height: 39.6 }, LETTER)).toMatchObject({ top: '0.000%', height: '5.000%' });
  });

  it('clamps a box that pokes past every edge', () => {
    expect(toPercentBox({ x: -50, y: -20, width: 1000, height: 900 }, LETTER)).toEqual({
      left: '0.000%',
      top: '0.000%',
      width: '100.000%',
      height: '100.000%',
    });
  });
});

// --- Design addendum 2026-09-23 §5.1 amendment: rotated pages, review fix round 1 ---

describe('toPercentBox rotation', () => {
  // Flush against the page's own top-left corner in PDF user space: x = 0 (the left edge), and
  // y + height = page height (the top edge, since PDF y counts up from the bottom).
  const PAGE = { width: 200, height: 100, originX: 0, originY: 0 };
  const BOX: Box = { x: 0, y: 95, width: 20, height: 5 };

  it('an unrotated page keeps a top-left box at the top-left', () => {
    expect(toPercentBox(BOX, { ...PAGE, rotation: 0 })).toEqual({ left: '0.000%', top: '0.000%', width: '10.000%', height: '5.000%' });
  });

  it('a 90° page turns the same box to the top-right, with width/height swapped', () => {
    expect(toPercentBox(BOX, { ...PAGE, rotation: 90 })).toEqual({ left: '95.000%', top: '0.000%', width: '5.000%', height: '10.000%' });
  });

  it('a 180° page turns the same box to the bottom-right', () => {
    expect(toPercentBox(BOX, { ...PAGE, rotation: 180 })).toEqual({ left: '90.000%', top: '95.000%', width: '10.000%', height: '5.000%' });
  });

  it('a 270° page turns the same box to the bottom-left, with width/height swapped', () => {
    expect(toPercentBox(BOX, { ...PAGE, rotation: 270 })).toEqual({ left: '0.000%', top: '90.000%', width: '5.000%', height: '10.000%' });
  });

  it('a box whose numbers are not finite projects to 0%, not the invalid CSS value "NaN%"', () => {
    expect(toPercentBox({ x: NaN, y: NaN, width: NaN, height: NaN }, { ...PAGE, rotation: 0 })).toEqual({
      left: '0.000%',
      top: '0.000%',
      width: '0.000%',
      height: '0.000%',
    });
  });
});

describe('displaySize', () => {
  const PAGE = { width: 612, height: 792 };

  it('keeps width/height at 0° and 180°', () => {
    expect(displaySize({ ...PAGE, rotation: 0 })).toEqual({ width: 612, height: 792 });
    expect(displaySize({ ...PAGE, rotation: 180 })).toEqual({ width: 612, height: 792 });
  });

  it('swaps width/height at 90° and 270°', () => {
    expect(displaySize({ ...PAGE, rotation: 90 })).toEqual({ width: 792, height: 612 });
    expect(displaySize({ ...PAGE, rotation: 270 })).toEqual({ width: 792, height: 612 });
  });
});
