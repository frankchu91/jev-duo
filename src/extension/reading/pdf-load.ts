// The one file that talks to pdf.js (design addendum §6.2), and it does so through an injected module
// rather than an import: the browser build (`pdfjs-dist`, bundled into the reader page) and the Node
// legacy build (`pdfjs-dist/legacy/build/pdf.mjs`, used by the unit test) behave identically here, and
// neither one belongs in a unit test's dependency graph by force. Everything downstream of this file
// sees PageText and nothing else.
//
// The shapes below are the narrowest both builds satisfy, narrowed again at runtime: pdf.js's own
// .d.ts types are far more specific than what this needs, and pinning to them would make a pdfjs-dist
// patch release able to break `pnpm typecheck`.

import type { PageText, TextItem } from './pdf-text';

export interface PdfViewportLike {
  width: number;
  height: number;
}

export interface PdfRenderTaskLike {
  promise: Promise<void>;
}

export interface PdfPageLike {
  /** [x0, y0, x1, y1] in PDF user space. */
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
  getViewport(params: { scale: number }): PdfViewportLike;
  /** pdf.js 6 takes the canvas itself, not a 2d context. */
  render(params: { canvas: HTMLCanvasElement; viewport: PdfViewportLike }): PdfRenderTaskLike;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<unknown>;
}

/** What `getDocument` really returns: the loading TASK, not just its promise. Destroying the task is
 * what tears the worker down and releases the file — the document alone cannot. */
export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(params: Record<string, unknown>): PdfLoadingTaskLike;
}

/** The three things pdf.js fetches at runtime instead of bundling (§5.3), as extension-origin URLs.
 * Without the standard fonts a PDF set in Times renders blank; without the cmaps CJK-encoded text
 * extracts as mojibake; without the wasm decoders a JPX/JBIG2 image throws mid-render. */
export interface PdfAssets {
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
  wasmUrl?: string;
}

export interface OpenedPdf {
  pages: PageText[];
  metaTitle?: string;
  /** Draws page `pageNumber` into `canvas` at `cssWidth` CSS pixels wide, `pixelRatio` device pixels
   * to each. Rejects with whatever pdf.js rejected with: what a failed page means is the caller's
   * decision, and the reader page's answer (§5.3) is to show that page's text instead. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number): Promise<void>;
  /** Destroys the loading task. The reader calls this before opening the next document. */
  destroy(): Promise<void>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One pdf.js text item -> one TextItem. Marked-content items (`{ type: 'beginMarkedContent' }`) carry
 * no transform at all and are skipped, which is why the return type is optional. */
function toTextItem(raw: unknown): TextItem | undefined {
  const item = raw as { str?: unknown; width?: unknown; transform?: unknown };
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6) return undefined;
  return {
    str: typeof item.str === 'string' ? item.str : '',
    x: num(t[4]),
    y: num(t[5]),
    // For an unrotated matrix [s, 0, 0, s, x, y] this is exactly the font size.
    size: Math.hypot(num(t[1]), num(t[3])),
    width: num(item.width),
    rotated: Math.abs(num(t[1])) > 0.01 || Math.abs(num(t[2])) > 0.01,
  };
}

function metaTitleOf(meta: unknown): string | undefined {
  const info = (meta as { info?: { Title?: unknown } } | undefined)?.info;
  const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
  return title === '' ? undefined : title;
}

/** §5.2. Unlike `loadPages` this keeps the document OPEN — that is the whole difference, and the whole
 * point: a reader that draws the pages needs the same worker alive for as long as it is on screen.
 *
 * `isEvalSupported: false` keeps pdf.js from compiling font programs with `eval` (the extension CSP
 * forbids it anyway); `useSystemFonts: false` keeps it from reaching for local fonts it does not need. */
export async function openPdf(data: ArrayBuffer, pdfjs: PdfjsLike, assets: PdfAssets = {}): Promise<OpenedPdf> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, ...assets });
  const doc = await task.promise;

  const pages: PageText[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const view = page.view;
    pages.push({
      page: n,
      width: num(view[2]) - num(view[0]),
      height: num(view[3]) - num(view[1]),
      originX: num(view[0]),
      originY: num(view[1]),
      items: content.items.map(toTextItem).filter((i): i is TextItem => i !== undefined),
    });
  }
  const metaTitle = metaTitleOf(await doc.getMetadata());

  return {
    pages,
    metaTitle,
    async renderPage(pageNumber, canvas, cssWidth, pixelRatio) {
      const page = await doc.getPage(pageNumber); // pdf.js caches pages, so a re-render is cheap
      // The UNSCALED viewport, not `page.view`: it is what pdf.js renders against, and it already
      // accounts for a page's /Rotate, which the raw MediaBox does not.
      const base = page.getViewport({ scale: 1 });
      const scale = (cssWidth / base.width) * pixelRatio;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
    },
    async destroy() {
      await task.destroy?.();
    },
  };
}

/** The text-only path, unchanged for its callers and its tests: open, take the text, always close.
 * `pagesToBlocks` never needs the document again, so nothing is gained by holding the worker open. */
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }> {
  const opened = await openPdf(data, pdfjs);
  try {
    return { pages: opened.pages, metaTitle: opened.metaTitle };
  } finally {
    await opened.destroy();
  }
}
