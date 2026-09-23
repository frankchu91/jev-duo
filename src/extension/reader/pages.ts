// The reader page's document: one <section> per PDF page, a canvas pdf.js draws that page on, and one
// absolutely-positioned overlay per passage (design addendum §5.3). The overlays ARE the
// `ArticlePassage.el` handed to mountReader, so READER_CSS's jd-hl/jd-dim/jd-flash, the panel's
// scroll-to-row and the whole judging loop work on them with no special case anywhere in reading/.
//
// Nothing here touches chrome.*, fetch or pdf.js: it takes a parsed PdfDoc, its PageText[] and a
// render function — which is what makes all of it testable in jsdom. IntersectionObserver and
// ResizeObserver do not exist in jsdom at all, so both are behind injectable factories whose defaults
// are `typeof`-guarded no-ops: importing this module in a test observes nothing and renders nothing.

import { passageId } from '../../core/reading';
import type { ArticlePassage } from '../reading/article';
import { toPercentBox, type Block, type PageText, type PdfDoc } from '../reading/pdf-text';

/** A page and a half of viewport in each direction, so a canvas is normally drawn before it is seen. */
export const OBSERVER_ROOT_MARGIN = '150% 0px';
/** At most this many renders in flight. Two keeps a fast scroll responsive without spending the main
 * thread rasterising pages that have already gone past. */
export const RENDER_CONCURRENCY = 2;
/** A drawn canvas further than this many pages from the nearest visible section is released. A letter
 * page at 2x on a wide window is ~13 MB of backing store; a hundred of them is a killed tab. */
export const RELEASE_PAGE_DISTANCE = 8;
/** Re-render when a section's width has moved by more than this share of the width it was drawn at.
 * Under that, the browser's own scaling of the existing bitmap is not worth a re-raster. */
export const RESIZE_WIDTH_CHANGE = 0.25;
export const RESIZE_DEBOUNCE_MS = 300;

export interface PageSection {
  page: number;
  section: HTMLElement;
  canvas: HTMLCanvasElement;
  /** This page's overlays, in document order — what the render-failure fallback fills with text. */
  blocks: Array<{ text: string; el: HTMLElement }>;
}

export interface RenderedDoc {
  passages: ArticlePassage[];
  sections: PageSection[];
}

/** §5.3. Builds the document into `container` (cleared first): a small <h1> with the title, then one
 * section per PAGE — including a page that contributed no text at all, which still has a picture worth
 * showing. Heading blocks get no overlay: they are already drawn on the canvas and are never judged.
 * Passage indexes run in document order across pages; the MAX_PASSAGES cap has already been applied,
 * by `pagesToBlocks`, to `doc.blocks`. */
export function render(doc: PdfDoc, pages: PageText[], container: HTMLElement): RenderedDoc {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = doc.title;
  container.appendChild(h1);

  const byPage = new Map<number, Block[]>();
  for (const block of doc.blocks) {
    if (block.kind !== 'passage') continue;
    const list = byPage.get(block.page);
    if (list) list.push(block);
    else byPage.set(block.page, [block]);
  }

  const passages: ArticlePassage[] = [];
  const sections: PageSection[] = [];
  for (const pageText of pages) {
    const section = document.createElement('section');
    section.className = 'jd-page';
    section.dataset.page = String(pageText.page);
    // The page's own proportions, so the section reserves the right space before anything is drawn:
    // that is what keeps the overlays in place and the scroll position stable while canvases are
    // drawn and released underneath them.
    section.style.aspectRatio = `${pageText.width} / ${pageText.height}`;

    const mark = document.createElement('div');
    mark.className = 'jd-page-mark';
    mark.textContent = `p. ${pageText.page}`;

    const canvas = document.createElement('canvas');
    canvas.className = 'jd-canvas';
    section.append(mark, canvas);

    const blocks: PageSection['blocks'] = [];
    for (const block of byPage.get(pageText.page) ?? []) {
      const el = document.createElement('div');
      el.className = 'jd-block';
      el.dataset.index = String(passages.length);
      el.dataset.page = String(pageText.page);
      const box = toPercentBox(block.box, pageText);
      el.style.left = box.left;
      el.style.top = box.top;
      el.style.width = box.width;
      el.style.height = box.height;
      section.appendChild(el);
      passages.push({ id: passageId(block.text), index: passages.length, text: block.text, page: pageText.page, el });
      blocks.push({ text: block.text, el });
    }

    container.appendChild(section);
    sections.push({ page: pageText.page, section, canvas, blocks });
  }
  return { passages, sections };
}

export type RenderPageFn = (pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number) => Promise<void>;

/** The one method this file needs from an observer. */
export interface VisibilityObserver {
  disconnect(): void;
}

/** Reports a section entering or leaving the neighbourhood of the viewport. */
export type ObserveFactory = (sections: PageSection[], onChange: (page: number, visible: boolean) => void) => VisibilityObserver;

/** Reports that the sections' width changed. The implementation owns its own debounce. */
export type ResizeFactory = (sections: PageSection[], onResize: () => void) => VisibilityObserver;

export interface PageRenderer {
  /** The pages whose canvas currently holds pixels, ascending. */
  rendered(): number[];
  destroy(): void;
}

export interface PageRendererDeps {
  sections: PageSection[];
  renderPage: RenderPageFn;
  observe?: ObserveFactory;
  onResize?: ResizeFactory;
  pixelRatio?: () => number;
}

const defaultObserve: ObserveFactory = (sections, onChange) => {
  if (typeof IntersectionObserver === 'undefined') return { disconnect: () => {} }; // jsdom: nothing is ever visible
  const byElement = new Map<Element, number>(sections.map((s) => [s.section, s.page]));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = byElement.get(entry.target);
        if (page !== undefined) onChange(page, entry.isIntersecting);
      }
    },
    { rootMargin: OBSERVER_ROOT_MARGIN },
  );
  for (const s of sections) io.observe(s.section);
  return { disconnect: () => io.disconnect() };
};

const defaultResize: ResizeFactory = (sections, onResize) => {
  if (typeof ResizeObserver === 'undefined') return { disconnect: () => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onResize, RESIZE_DEBOUNCE_MS);
  });
  // One section is enough: they all share the column's width, so a resize moves all of them at once.
  if (sections[0]) ro.observe(sections[0].section);
  return {
    disconnect: () => {
      if (timer !== undefined) clearTimeout(timer);
      ro.disconnect();
    },
  };
};

const defaultPixelRatio = (): number => Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

/** §5.3's lazy canvases. Draws a page as it nears the viewport, at most two at a time, and gives the
 * memory back once a page is far enough behind — everything else about the document (the overlays,
 * the panel, the judging) is untouched by any of it, because the overlays are positioned in
 * percentages and never move. */
export function mountPageRenderer(deps: PageRendererDeps): PageRenderer {
  const { sections, renderPage } = deps;
  const pixelRatio = deps.pixelRatio ?? defaultPixelRatio;
  const byPage = new Map(sections.map((s) => [s.page, s]));
  const visible = new Set<number>();
  /** page -> the section width it was drawn at. Its KEYS are "this canvas holds pixels". */
  const drawn = new Map<number, number>();
  const queue: number[] = [];
  const inFlight = new Set<number>();
  let destroyed = false;

  function distanceFromVisible(page: number): number {
    let best = Infinity;
    for (const v of visible) best = Math.min(best, Math.abs(v - page));
    return best;
  }

  /** Nothing is released while nothing is visible: at startup, before the first intersection callback
   * has said where the viewport is, every distance would be Infinity and every canvas would go. */
  function release(): void {
    if (visible.size === 0) return;
    for (const page of [...drawn.keys()]) {
      if (distanceFromVisible(page) <= RELEASE_PAGE_DISTANCE) continue;
      const entry = byPage.get(page);
      if (!entry) continue;
      // Zeroing both dimensions is what actually frees the backing store, and dropping the `drawn`
      // entry is what re-arms `enqueue` for the next approach.
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      drawn.delete(page);
    }
  }

  function enqueue(page: number): void {
    if (destroyed || drawn.has(page) || inFlight.has(page) || queue.includes(page)) return;
    queue.push(page);
    pump();
  }

  function pump(): void {
    while (!destroyed && inFlight.size < RENDER_CONCURRENCY && queue.length > 0) {
      const page = queue.shift();
      if (page === undefined) return;
      void draw(page);
    }
  }

  /** §5.3's render failure: the page keeps its place and its passages stay readable and judgeable
   * without a canvas. The overlay elements never change identity, so a judge still running is
   * unaffected — and a tag the panel had already appended is put back after the text. */
  function showText(entry: PageSection): void {
    entry.section.classList.add('jd-render-failed');
    for (const block of entry.blocks) {
      const tags = [...block.el.querySelectorAll('.jd-rtag')];
      block.el.textContent = block.text;
      block.el.classList.add('jd-block-text');
      for (const tag of tags) block.el.appendChild(tag);
    }
  }

  async function draw(page: number): Promise<void> {
    const entry = byPage.get(page);
    if (!entry) return;
    inFlight.add(page);
    const cssWidth = entry.section.clientWidth;
    try {
      await renderPage(page, entry.canvas, cssWidth, pixelRatio());
      if (!destroyed) drawn.set(page, cssWidth);
    } catch {
      if (!destroyed) showText(entry);
    } finally {
      inFlight.delete(page);
      pump();
    }
  }

  function onVisibilityChange(page: number, isVisible: boolean): void {
    if (destroyed) return;
    if (isVisible) {
      visible.add(page);
      enqueue(page);
    } else {
      visible.delete(page);
    }
    release();
  }

  /** The overlays are percentages, so a resize recomputes no geometry — only bitmaps, and only those
   * whose width really moved. Every DRAWN page is checked rather than only the strictly visible ones:
   * a drawn page is within RELEASE_PAGE_DISTANCE of the viewport by construction, and skipping it
   * would pin it at the old width forever, since a drawn page is never re-queued. */
  function onResized(): void {
    if (destroyed) return;
    for (const [page, width] of [...drawn]) {
      const entry = byPage.get(page);
      if (!entry) continue;
      const next = entry.section.clientWidth;
      if (width > 0 && Math.abs(next - width) <= RESIZE_WIDTH_CHANGE * width) continue;
      drawn.delete(page);
      enqueue(page);
    }
  }

  const visibility = (deps.observe ?? defaultObserve)(sections, onVisibilityChange);
  const resizes = (deps.onResize ?? defaultResize)(sections, onResized);

  return {
    rendered: () => [...drawn.keys()].sort((a, b) => a - b),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      queue.length = 0;
      visibility.disconnect();
      resizes.disconnect();
    },
  };
}
