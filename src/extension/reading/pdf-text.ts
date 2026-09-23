// PDF text geometry (design addendum §6.1). pdf.js hands back a flat list of positioned strings with
// no notion of a line, a column or a paragraph; rebuilding those is this file's whole job, and it is
// deliberately pdf.js-free and pure so every rule can be driven from synthetic input in a unit test.
// Everything is per page, then joined in page order: a block never spans a page break.

import { MAX_PASSAGES, MIN_PASSAGE_CHARS } from '../../core/reading';

export interface TextItem {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  rotated: boolean;
}

/** A rectangle in PDF user space: origin bottom-left, y up, points. The one geometry type the reader
 * page speaks — everything it draws goes through `toPercentBox` first. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  /** `page.view[0]`/`page.view[1]`: 0 for a synthetic page, non-zero for a cropped one, and the
   * reason `toPercentBox` subtracts rather than divides straight away. */
  originX: number;
  originY: number;
  items: TextItem[];
}

export type Block =
  | { kind: 'heading'; text: string; page: number; box: Box }
  | { kind: 'passage'; text: string; page: number; box: Box };

export interface PdfDoc {
  title: string;
  blocks: Block[];
}

const LINE_Y_TOLERANCE = 2;
const HEADER_Y_TOLERANCE = 3;
const RUNNING_MIN_PAGES = 3;
const FULL_WIDTH_SHARE = 0.6;
const GAP_FACTOR = 1.45;
const SIZE_STEP = 1;
const HEADING_FACTOR = 1.15;
const HEADING_MAX_CHARS = 120;
const TITLE_MIN_CHARS = 8;
const PAGE_NUMBER_MAX_CHARS = 4;
const ROMAN = /^[ivxlcdm]+$/i;

type Column = 'full' | 'left' | 'right';

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
  page: number;
  column: Column;
}

interface Draft {
  kind: 'heading' | 'passage';
  text: string;
  page: number;
  size: number;
  box: Box;
}

/** §6.1.2. Items join the CURRENT line, in the order pdf.js emitted them: a global sort by y would
 * merge the left and right columns of a two-column page into one line, since they share baselines. */
function linesOf(page: PageText): Line[] {
  const groups: TextItem[][] = [];
  for (const item of page.items) {
    if (item.rotated || item.str.trim() === '') continue;
    const current = groups[groups.length - 1];
    if (current && Math.abs(item.y - current[0].y) <= LINE_Y_TOLERANCE) current.push(item);
    else groups.push([item]);
  }
  return groups.map((items) => toLine(items, page));
}

function toLine(items: TextItem[], page: PageText): Line {
  // pdf.js items carry their own spaces, so the join is '' — adding one would double every space.
  const text = [...items]
    .sort((a, b) => a.x - b.x)
    .map((it) => it.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  let biggest = items[0];
  for (const it of items) if (it.str.length > biggest.str.length) biggest = it;
  const x = Math.min(...items.map((it) => it.x));
  const right = Math.max(...items.map((it) => it.x + it.width));
  // §6.1.5: a line that spans most of the page is `full` and ends whatever column band it follows.
  const column: Column = right - x >= FULL_WIDTH_SHARE * page.width ? 'full' : x < page.width / 2 ? 'left' : 'right';
  return { text, x, right, y: items[0].y, size: biggest.size, page: page.page, column };
}

/** §6.1.3: the size, rounded to half a point, that carries the most characters in the document. Ties
 * go to the smaller size so the result never depends on page order. */
function bodySize(lines: Line[]): number {
  const chars = new Map<number, number>();
  for (const line of lines) {
    const bucket = Math.round(line.size * 2) / 2;
    chars.set(bucket, (chars.get(bucket) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [size, count] of chars) {
    if (count > bestChars || (count === bestChars && size < best)) {
      best = size;
      bestChars = count;
    }
  }
  return best || 1;
}

const normalize = (text: string): string => text.toLowerCase().replace(/\d/g, '#');

const isPageNumber = (text: string): boolean => text.length <= PAGE_NUMBER_MAX_CHARS && (/^\d+$/.test(text) || ROMAN.test(text));

/** §6.1.4. A running header is the same normalised text at the same height on enough pages; "enough"
 * has a floor of two, because one page can never show a repetition and "half of two" would otherwise
 * drop every line of a two-page document — including its title.
 *
 * Linear (after a sort) in each equal-text group rather than quadratic: the group is walked once with
 * a window over `y` holding exactly the lines within HEADER_Y_TOLERANCE of the current line, and a
 * page -> line-count map whose `size` IS the distinct-page count for that window. Scanning the whole
 * group per line instead costs 381 ms on a 120-page table whose 12,000 rows all normalise to the same
 * shape (digits become '#'), and this runs on the reader page's main thread. */
function runningFilter(lines: Line[], pageCount: number): (line: Line) => boolean {
  const threshold = pageCount >= 6 ? RUNNING_MIN_PAGES : Math.max(2, Math.ceil(pageCount / 2));
  const byText = new Map<string, Line[]>();
  for (const line of lines) {
    const key = normalize(line.text);
    const list = byText.get(key);
    if (list) list.push(line);
    else byText.set(key, [line]);
  }

  const dropped = new Set<Line>();
  for (const group of byText.values()) {
    // A window can never hold more distinct pages than the group holds lines.
    if (group.length < threshold) continue;
    const sorted = [...group].sort((a, b) => a.y - b.y);
    const pages = new Map<number, number>(); // page -> how many lines of the current window sit on it
    let lo = 0;
    let hi = 0;
    // Both window edges only ever move right, so a line already dropped by an earlier window is never
    // revisited: `marked` is where the next marking pass starts, which keeps the whole walk linear.
    let marked = 0;
    for (const line of sorted) {
      while (hi < sorted.length && sorted[hi].y <= line.y + HEADER_Y_TOLERANCE) {
        pages.set(sorted[hi].page, (pages.get(sorted[hi].page) ?? 0) + 1);
        hi += 1;
      }
      while (sorted[lo].y < line.y - HEADER_Y_TOLERANCE) {
        const left = (pages.get(sorted[lo].page) ?? 0) - 1;
        if (left > 0) pages.set(sorted[lo].page, left);
        else pages.delete(sorted[lo].page);
        lo += 1;
      }
      if (pages.size < threshold) continue;
      for (let i = Math.max(lo, marked); i < hi; i++) dropped.add(sorted[i]);
      marked = hi;
    }
  }
  return (line) => dropped.has(line) || isPageNumber(line.text);
}

/** §6.1.5. Top to bottom, with each columnar band re-ordered so its left column is read before its
 * right one; a full-width line closes the band it follows. */
function readingOrder(lines: Line[]): Line[] {
  const out: Line[] = [];
  let band: Line[] = [];
  const flush = (): void => {
    if (band.length === 0) return;
    out.push(...band.filter((l) => l.column === 'left'), ...band.filter((l) => l.column === 'right'));
    band = [];
  };
  for (const line of [...lines].sort((a, b) => b.y - a.y)) {
    if (line.column === 'full') {
      flush();
      out.push(line);
      continue;
    }
    band.push(line);
  }
  flush();
  return out;
}

/** §6.1.6 and §6.1.7's one rule, asked twice: of a LINE, to decide whether it starts a new block, and
 * of the finished BLOCK, to decide whether that block is a heading. Written out at both sites, the two
 * copies had already drifted apart textually; a block whose kind disagreed with the split that made it
 * is the bug this shape rules out. */
const isHeading = (size: number, length: number, body: number): boolean => size >= HEADING_FACTOR * body && length <= HEADING_MAX_CHARS;

/** §5.1's line box: the baseline `y` with a quarter em of descent below it and one em of ascent above.
 * pdf.js reports a baseline and a width and nothing else, so the height is inferred from the size. */
const lineBox = (line: Line): Box => ({
  x: line.x,
  y: line.y - 0.25 * line.size,
  width: line.right - line.x,
  height: 1.25 * line.size,
});

/** The smallest box containing both. A block's box is its lines' boxes folded through this. */
function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** §6.1.6's join rule: a trailing hyphen before a lowercase continuation is a word broken across
 * lines; a hyphen before anything else (a compound, a capitalised name) is part of the word. */
function joinInto(text: string, next: string): string {
  if (text.endsWith('-') && /^[a-z]/.test(next)) return `${text.slice(0, -1)}${next}`;
  return `${text} ${next}`;
}

function draftsOfPage(ordered: Line[], body: number): Draft[] {
  const out: Draft[] = [];
  let prev: Line | undefined;
  let text = '';
  let size = 0;
  let page = 0;
  let box: Box = { x: 0, y: 0, width: 0, height: 0 };

  const flush = (): void => {
    if (text === '') return;
    // §6.1.7: a big short block is a heading, anything else long enough is a passage, the rest is
    // dropped — a stray line of page furniture never becomes something to judge.
    if (isHeading(size, text.length, body)) out.push({ kind: 'heading', text, page, size, box });
    else if (text.length >= MIN_PASSAGE_CHARS) out.push({ kind: 'passage', text, page, size, box });
    text = '';
  };

  for (const line of ordered) {
    const starts =
      prev === undefined ||
      prev.column !== line.column ||
      prev.y - line.y > GAP_FACTOR * prev.size ||
      Math.abs(line.size - prev.size) > SIZE_STEP ||
      isHeading(line.size, line.text.length, body);
    if (starts) {
      flush();
      text = line.text;
      size = line.size;
      page = line.page;
      box = lineBox(line);
    } else {
      text = joinInto(text, line.text);
      box = unionBox(box, lineBox(line));
    }
    prev = line;
  }
  flush();
  return out;
}

/** The whole of §6.1. `fallbackTitle` is the PDF's metadata title, else the file name (§6.1.8). */
export function pagesToBlocks(pages: PageText[], fallbackTitle: string): PdfDoc {
  const perPage = pages.map((page) => linesOf(page));
  const allLines = perPage.flat();
  const body = bodySize(allLines);
  const drop = runningFilter(allLines, pages.length);

  const drafts: Draft[] = [];
  for (const lines of perPage) drafts.push(...draftsOfPage(readingOrder(lines.filter((l) => !drop(l))), body));

  let title = fallbackTitle;
  let titleSize = -1;
  for (const draft of drafts) {
    if (draft.page !== 1 || draft.text.length < TITLE_MIN_CHARS || draft.size <= titleSize) continue;
    title = draft.text;
    titleSize = draft.size;
  }

  // Two caps of MAX_PASSAGES, counted separately: headings are never judged, so they cost nothing
  // against the passage budget, but they are still DOM the reader page has to build — a 300-slide deck
  // is thousands of short big-text blocks and every one of them would become an <h2>.
  const blocks: Block[] = [];
  let passages = 0;
  let headings = 0;
  for (const draft of drafts) {
    if (draft.kind === 'passage') {
      if (passages >= MAX_PASSAGES) continue;
      passages += 1;
    } else {
      if (headings >= MAX_PASSAGES) continue;
      headings += 1;
    }
    blocks.push({ kind: draft.kind, text: draft.text, page: draft.page, box: draft.box });
  }
  return { title, blocks };
}

const clampPercent = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);
const percent = (v: number): string => `${clampPercent(v).toFixed(3)}%`;

/** §5.1. PDF user space to the CSS percentages an overlay is positioned by: subtract the page origin,
 * flip the y axis (PDF counts up from the bottom, CSS down from the top), scale to the page, clamp.
 *
 * Percentages, not pixels, is the whole trick: the overlays stay correct at any rendered canvas size,
 * so a window resize costs nothing to recompute and a canvas re-rendered at a new width needs no
 * second pass over the geometry. */
export function toPercentBox(
  box: Box,
  page: { width: number; height: number; originX: number; originY: number },
): { left: string; top: string; width: string; height: string } {
  return {
    left: percent(((box.x - page.originX) / page.width) * 100),
    top: percent(((page.originY + page.height - (box.y + box.height)) / page.height) * 100),
    width: percent((box.width / page.width) * 100),
    height: percent((box.height / page.height) * 100),
  };
}
