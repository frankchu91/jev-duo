// The one test that runs real pdf.js: the legacy build, in Node, with no DOM and no canvas, over the
// committed fixture. Everything else about the PDF path is driven from synthetic PageText, so this is
// specifically the "do our transform/view readings match what pdf.js actually reports?" test.

import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPages, type PdfjsLike } from '../../../src/extension/reading/pdf-load';
import { pagesToBlocks } from '../../../src/extension/reading/pdf-text';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../e2e/fixtures');
const ROOT = path.resolve(HERE, '../../..');

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

// Final wave, IMPORTANT: pdfjs-dist@6 declares `engines.node >= 22.13` while this package publishes
// `engines.node >= 20`, and the CLI bundle never references pdf.js — only the extension's reader page
// bundles it. Listed under `dependencies`, it would have broken `npm i -g jev-duo` on Node 20/21 for
// code the CLI cannot even reach.
describe('pdfjs-dist packaging', () => {
  it('is a dev dependency, imported by the reader page and nothing else in src', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['pdfjs-dist']).toBeUndefined();
    expect(pkg.devDependencies?.['pdfjs-dist']).toBe('^6.3.289');

    const src = path.join(ROOT, 'src');
    const importers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /from '(pdfjs-dist)/.test(readFileSync(path.join(src, file), 'utf8')));
    expect(importers).toEqual([path.join('extension', 'reader', 'reader.ts')]);
  });
});
