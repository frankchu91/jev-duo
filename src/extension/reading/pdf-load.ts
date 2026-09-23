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

export interface PdfPageLike {
  /** [x0, y0, x1, y1] in PDF user space. */
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<unknown>;
  destroy?(): Promise<void>;
}

export interface PdfjsLike {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike> };
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

/** `isEvalSupported: false` keeps pdf.js from compiling font programs with `eval` (the extension CSP
 * forbids it anyway); `useSystemFonts: false` keeps it from reaching for local fonts it does not need
 * to report text positions. The document is destroyed either way, so neither the reader page nor a
 * Node test is left holding a live worker. */
export async function loadPages(data: ArrayBuffer, pdfjs: PdfjsLike): Promise<{ pages: PageText[]; metaTitle?: string }> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const view = page.view;
      pages.push({
        page: n,
        width: num(view[2]) - num(view[0]),
        height: num(view[3]) - num(view[1]),
        items: content.items.map(toTextItem).filter((i): i is TextItem => i !== undefined),
      });
    }
    return { pages, metaTitle: metaTitleOf(await doc.getMetadata()) };
  } finally {
    await doc.destroy?.();
  }
}
