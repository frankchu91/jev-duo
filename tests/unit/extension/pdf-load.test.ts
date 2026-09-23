// The one test that runs real pdf.js: the legacy build, in Node, with no DOM and no canvas, over the
// committed fixture. Everything else about the PDF path is driven from synthetic PageText, so this is
// specifically the "do our transform/view readings match what pdf.js actually reports?" test.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPages, openPdf, type PdfjsLike, type PdfPageLike } from '../../../src/extension/reading/pdf-load';
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

  it('openPdf reports the page origins and hands back a working destroy', async () => {
    const opened = await openPdf(await sampleBytes(), await legacyPdfjs());
    try {
      expect(opened.metaTitle).toBe('Sample Paper');
      expect(opened.pages.map((p) => p.page)).toEqual([1, 2]);
      // An uncropped letter page: MediaBox starts at (0, 0), so both origins are 0.
      expect(opened.pages.map((p) => [p.originX, p.originY])).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(opened.pages[0].width).toBe(612);
      expect(opened.pages[0].height).toBe(792);
    } finally {
      await opened.destroy(); // the loading task, not just the document: no worker is left alive
    }
  });
});

// --- Design addendum 2026-09-23 §5.2: the page as PIXELS, against a pdf.js that is not pdf.js ---

/** A one-page pdf.js stand-in. `getViewport({ scale })` scales a letter page — swapped for a 90°/270°
 * `rotate`, the same as real pdf.js does — and `render` records the `{ canvas, viewport }` it was
 * handed (pdf.js 6 takes the canvas itself, not a 2d context) and resolves — or rejects — with whatever
 * `onRender` does. Once the task's `destroy` has been called, `getPage` starts rejecting, the same as a
 * real document with its worker torn down — which is what lets a test assert that `renderPage` after
 * `destroy()` rejects instead of hanging. */
function fakePdfjs(
  onRender: () => Promise<void> = () => Promise.resolve(),
  rotate = 0,
): {
  pdfjs: PdfjsLike;
  calls: Array<{ canvas: HTMLCanvasElement; viewport: { width: number; height: number } }>;
  params: Array<Record<string, unknown>>;
  destroys: unknown[];
} {
  const calls: Array<{ canvas: HTMLCanvasElement; viewport: { width: number; height: number } }> = [];
  const params: Array<Record<string, unknown>> = [];
  const destroys: unknown[] = [];
  const swapped = rotate === 90 || rotate === 270;
  let destroyed = false;
  const page: PdfPageLike = {
    view: [0, 0, 612, 792],
    rotate,
    async getTextContent() {
      return { items: [] };
    },
    getViewport({ scale }) {
      return swapped ? { width: 792 * scale, height: 612 * scale } : { width: 612 * scale, height: 792 * scale };
    },
    render(args) {
      calls.push(args);
      return { promise: onRender() };
    },
  };
  const pdfjs: PdfjsLike = {
    getDocument(p) {
      params.push(p);
      return {
        promise: Promise.resolve({
          numPages: 1,
          async getPage() {
            if (destroyed) throw new Error('document is destroyed');
            return page;
          },
          getMetadata: async () => ({}),
        }),
        async destroy() {
          destroyed = true;
          destroys.push(undefined);
        },
      };
    },
  };
  return { pdfjs, calls, params, destroys };
}

/** This file runs under the node environment (no DOM at all), and `renderPage` only ever writes
 * `width`/`height` — so a bare object is the honest stand-in for a canvas here. */
const fakeCanvas = (): HTMLCanvasElement => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('openPdf renderPage', () => {
  it('sizes the canvas from cssWidth x pixelRatio, rounding up, and renders exactly once', async () => {
    const { pdfjs, calls } = fakePdfjs();
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);
    const canvas = fakeCanvas();

    await opened.renderPage(1, canvas, 800, 2);

    // scale = 800 / 612 x 2 = 2.6143…; 612 x scale is exactly 1600, 792 x scale is 2070.588… -> 2071.
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(2071);
    expect(calls).toHaveLength(1);
    expect(calls[0].canvas).toBe(canvas);
    expect(calls[0].viewport.width).toBe(1600);
  });

  it('propagates a rejecting render to the caller rather than swallowing it', async () => {
    const { pdfjs } = fakePdfjs(() => Promise.reject(new Error('canvas is gone')));
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);

    await expect(opened.renderPage(1, fakeCanvas(), 800, 2)).rejects.toThrow('canvas is gone');
  });

  it('passes the runtime assets and both hardening flags to getDocument', async () => {
    const { pdfjs, params } = fakePdfjs();

    const opened = await openPdf(new ArrayBuffer(8), pdfjs, {
      standardFontDataUrl: 'chrome-extension://x/standard_fonts/',
      cMapUrl: 'chrome-extension://x/cmaps/',
      cMapPacked: true,
      wasmUrl: 'chrome-extension://x/wasm/',
    });
    await opened.destroy();

    expect(params[0]).toMatchObject({
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: 'chrome-extension://x/standard_fonts/',
      cMapUrl: 'chrome-extension://x/cmaps/',
      cMapPacked: true,
      wasmUrl: 'chrome-extension://x/wasm/',
    });
  });
});

// --- Design addendum 2026-09-23 §5.1 amendment: rotated pages, review fix round 1 ---

describe('openPdf rotation', () => {
  it('reports PageText.rotation and renders at the already-swapped viewport size', async () => {
    const { pdfjs } = fakePdfjs(undefined, 90);
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);

    expect(opened.pages[0].rotation).toBe(90);

    const canvas = fakeCanvas();
    // The fake's getViewport({ scale: 1 }) for a 90° page is already { width: 792, height: 612 } —
    // the same swap real pdf.js performs — so cssWidth is matched against the SWAPPED base width.
    await opened.renderPage(1, canvas, 792, 2);

    // scale = cssWidth / base.width x pixelRatio = 792 / 792 x 2 = 2; the SWAPPED base (792 x 612)
    // scaled by 2 is exactly 1584 x 1224 — the turned page, not the raw 612 x 792 MediaBox.
    expect(canvas.width).toBe(1584);
    expect(canvas.height).toBe(1224);
  });
});

describe('openPdf destroy', () => {
  it('is idempotent: destroying twice destroys the underlying task once and never throws', async () => {
    const { pdfjs, destroys } = fakePdfjs();
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);

    await opened.destroy();
    await opened.destroy();

    expect(destroys).toHaveLength(1);
  });

  it('renderPage after destroy rejects rather than hanging', async () => {
    const { pdfjs } = fakePdfjs();
    const opened = await openPdf(new ArrayBuffer(8), pdfjs);

    await opened.destroy();

    await expect(opened.renderPage(1, fakeCanvas(), 800, 2)).rejects.toThrow('document is destroyed');
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

  // §5.3's assets. pdf.js keeps three things out of its bundle and fetches them at runtime, so the
  // build has to copy them next to the reader. The COPIES are asserted by tests/e2e/reading.spec.ts,
  // which always runs against a real `pnpm build`; this side asserts the sources exist and that the
  // build script names all three, because `pnpm check` runs `pnpm test` BEFORE `pnpm build` and a
  // unit test that read dist/ would fail on a clean tree.
  it('the standard fonts, cmaps and wasm decoders are present and named by the build script', () => {
    for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
      const dir = path.join(ROOT, 'node_modules', 'pdfjs-dist', folder);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    }
    expect(readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8')).toContain("['standard_fonts', 'cmaps', 'wasm']");
  });
});
