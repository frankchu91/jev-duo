// The one test that runs real pdf.js: the legacy build, in Node, with no DOM and no canvas, over the
// committed fixture. Everything else about the PDF path is driven from synthetic PageText, so this is
// specifically the "do our transform/view readings match what pdf.js actually reports?" test.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPages, type PdfjsLike } from '../../../src/extension/reading/pdf-load';
import { pagesToBlocks } from '../../../src/extension/reading/pdf-text';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures');

/** The specifier goes through a variable so TypeScript does not try to type-resolve a .mjs build that
 * ships no declarations; the shape it has to satisfy is asserted by `PdfjsLike` right here. */
async function legacyPdfjs(): Promise<PdfjsLike> {
  const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
  return (await import(specifier)) as unknown as PdfjsLike;
}

async function sampleBytes(): Promise<ArrayBuffer> {
  const file = await readFile(path.join(FIXTURES, 'sample.pdf'));
  return Uint8Array.from(file).buffer; // a copy, sized exactly: Buffer's own ArrayBuffer is pooled
}

describe('loadPages on tests/e2e/fixtures/sample.pdf', () => {
  it('reads two letter-sized pages, their metadata title and unrotated items', async () => {
    const { pages, metaTitle } = await loadPages(await sampleBytes(), await legacyPdfjs());

    expect(metaTitle).toBe('Sample Paper');
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].width).toBe(612);
    expect(pages[0].height).toBe(792);
    expect(pages[0].items.length).toBeGreaterThan(10);
    expect(pages[0].items.every((i) => !i.rotated)).toBe(true);
    expect(pages[0].items.some((i) => Math.round(i.size) === 18)).toBe(true); // the title
    expect(pages[0].items.some((i) => Math.round(i.size) === 10)).toBe(true); // the body
  });

  it('rebuilds the paper: the right title, at least six passages, no running header in any of them', async () => {
    const { pages, metaTitle } = await loadPages(await sampleBytes(), await legacyPdfjs());
    const doc = pagesToBlocks(pages, metaTitle ?? 'sample.pdf');

    expect(doc.title).toBe('Sample Paper');
    const passages = doc.blocks.filter((b) => b.kind === 'passage');
    expect(passages.length).toBeGreaterThanOrEqual(6);
    expect(passages.every((b) => !b.text.includes('Sample Paper - draft'))).toBe(true);
    expect(passages.every((b) => b.text.length >= 40)).toBe(true);
    expect(new Set(passages.map((b) => b.page))).toEqual(new Set([1, 2]));

    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual([
      'Sample Paper',
      '1 Introduction',
      '2 Method',
      '3 Acknowledgments',
    ]);
    // The line break inside "positional information" is rejoined with a space, and no paragraph is
    // left as a stray single line.
    expect(passages.some((b) => b.text.includes('Positional information is represented by fixed sinusoidal functions of the position index'))).toBe(true);
  });
});
