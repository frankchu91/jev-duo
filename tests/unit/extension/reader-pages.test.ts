// @vitest-environment jsdom
//
// The reader page's document, without the reader page (design addendum §5.3): `render` takes a parsed
// PdfDoc plus its PageText[] and builds sections, canvases and overlays; `mountPageRenderer` decides
// which canvases get drawn and when. Neither touches chrome.*, fetch or pdf.js — which is the whole
// reason they live in pages.ts rather than reader.ts.
//
// jsdom has NO IntersectionObserver and NO ResizeObserver, so both are injected here. That is not a
// test convenience: it is the same seam the real page uses, with the real page passing the real ones.

import { describe, expect, it } from 'vitest';
import type { Box, PageText, PdfDoc } from '../../../src/extension/reading/pdf-text';
import { mountPageRenderer, render, type ObserveFactory, type RenderPageFn, type ResizeFactory } from '../../../src/extension/reader/pages';

const letter = (n: number): PageText => ({ page: n, width: 612, height: 792, originX: 0, originY: 0, items: [] });

/** The three-line body block from pdf-text.test.ts, so the percentages below are traceable. */
const BODY: Box = { x: 72, y: 669.5, width: 235, height: 40.5 };
const HEAD: Box = { x: 72, y: 735.5, width: 468, height: 22.5 };

const PAGES: PageText[] = [letter(1), letter(2)];

const DOC: PdfDoc = {
  title: 'Sample Paper',
  blocks: [
    { kind: 'heading', text: '1 Introduction', page: 1, box: HEAD },
    { kind: 'passage', text: 'First passage of page one, long enough to be one.', page: 1, box: BODY },
    { kind: 'passage', text: 'Second passage of page one, also long enough to be one.', page: 1, box: BODY },
    { kind: 'passage', text: 'The only passage on page two, long enough to be one.', page: 2, box: BODY },
  ],
};

/** Many identical pages, each with one passage, for the observer cases. */
function bigDoc(pageCount: number): { doc: PdfDoc; pages: PageText[] } {
  const pages = Array.from({ length: pageCount }, (_, i) => letter(i + 1));
  const doc: PdfDoc = {
    title: 'Long',
    blocks: pages.map((p) => ({ kind: 'passage' as const, text: `The only passage on page ${p.page}, long enough to be one.`, page: p.page, box: BODY })),
  };
  return { doc, pages };
}

/** Flushes the microtask queue across a macrotask boundary, so a `finally` behind two awaits has run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An observer a test drives by hand: `enter`/`leave` are what a real IntersectionObserver reports. */
function fakeObserver(): { factory: ObserveFactory; enter(page: number): void; leave(page: number): void } {
  let notify: ((page: number, visible: boolean) => void) | undefined;
  return {
    factory: (_sections, onChange) => {
      notify = onChange;
      return {
        disconnect: () => {
          notify = undefined;
        },
      };
    },
    enter: (page) => notify?.(page, true),
    leave: (page) => notify?.(page, false),
  };
}

/** A renderer that never settles on its own: each call parks until the test resolves or rejects it. */
function fakeRenderer(): { calls: number[]; pending: Array<{ resolve(): void; reject(err: Error): void }>; renderPage: RenderPageFn } {
  const calls: number[] = [];
  const pending: Array<{ resolve(): void; reject(err: Error): void }> = [];
  const renderPage: RenderPageFn = (page) =>
    new Promise<void>((resolve, reject) => {
      calls.push(page);
      pending.push({ resolve: () => resolve(), reject });
    });
  return { calls, pending, renderPage };
}

const noResize: ResizeFactory = () => ({ disconnect: () => {} });

/** jsdom gives every element a clientWidth of 0; the resize case needs real numbers. */
const setWidth = (el: HTMLElement, px: number): void => {
  Object.defineProperty(el, 'clientWidth', { value: px, configurable: true });
};

describe('render', () => {
  it('builds one section per page, with the page proportions, a mark and a canvas', () => {
    const container = document.createElement('main');

    const { sections } = render(DOC, PAGES, container);

    const built = [...container.querySelectorAll<HTMLElement>('section.jd-page')];
    expect(built).toHaveLength(2);
    expect(built.map((s) => s.style.aspectRatio)).toEqual(['612 / 792', '612 / 792']);
    expect(built.map((s) => s.dataset.page)).toEqual(['1', '2']);
    expect([...container.querySelectorAll('.jd-page-mark')].map((m) => m.textContent)).toEqual(['p. 1', 'p. 2']);
    expect(container.querySelectorAll('canvas.jd-canvas')).toHaveLength(2);
    expect(container.querySelector('h1')?.textContent).toBe('Sample Paper');
    expect(sections.map((s) => s.page)).toEqual([1, 2]);
  });

  it('overlays only the passages, indexed in document order across pages', () => {
    const container = document.createElement('main');

    const { passages } = render(DOC, PAGES, container);

    const blocks = [...container.querySelectorAll<HTMLElement>('.jd-block')];
    expect(blocks).toHaveLength(3); // the heading is drawn on the canvas, never overlaid
    expect(blocks.map((b) => b.dataset.index)).toEqual(['0', '1', '2']);
    expect(blocks.map((b) => b.dataset.page)).toEqual(['1', '1', '2']);
    expect(passages.map((p) => p.el)).toEqual(blocks); // the overlays ARE the ArticlePassage elements
    expect(passages.map((p) => p.page)).toEqual([1, 1, 2]);
    expect(passages[0].text).toBe('First passage of page one, long enough to be one.');
  });

  it('positions each overlay with toPercentBox, in percentages', () => {
    const container = document.createElement('main');

    render(DOC, PAGES, container);

    // BODY on a 612 x 792 page with a (0, 0) origin.
    const first = container.querySelector<HTMLElement>('.jd-block');
    expect(first?.style.left).toBe('11.765%');
    expect(first?.style.top).toBe('10.354%');
    expect(first?.style.width).toBe('38.399%');
    expect(first?.style.height).toBe('5.114%');
  });

  it('renders a page that contributed no text at all — it still has a picture', () => {
    const container = document.createElement('main');
    const doc: PdfDoc = { title: 'Figure', blocks: [{ kind: 'passage', text: 'Only page two has words in it here.', page: 2, box: BODY }] };

    const { sections } = render(doc, PAGES, container);

    expect(sections).toHaveLength(2);
    expect(sections[0].blocks).toHaveLength(0);
    expect(sections[1].blocks).toHaveLength(1);
  });

  it('clears the container first, so a re-read does not stack two documents', () => {
    const container = document.createElement('main');
    container.textContent = 'stale content from a previous read';

    render({ title: 'T', blocks: [] }, [], container);

    expect(container.textContent).toBe('T');
    expect(container.querySelectorAll('.jd-page')).toHaveLength(0);
  });
});

describe('mountPageRenderer', () => {
  function mount(pageCount: number) {
    const container = document.createElement('main');
    const { doc, pages } = bigDoc(pageCount);
    const { sections } = render(doc, pages, container);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    const handle = mountPageRenderer({
      sections,
      renderPage: renderer.renderPage,
      observe: observer.factory,
      onResize: noResize,
      pixelRatio: () => 2,
    });
    return { sections, observer, renderer, handle };
  }

  it('draws nothing until a section comes into view', () => {
    const { renderer, handle } = mount(4);

    expect(renderer.calls).toEqual([]);
    expect(handle.rendered()).toEqual([]);
  });

  it('draws a section that comes into view, at its own width and the given pixel ratio', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    setWidth(sections[0].section, 800);
    const observer = fakeObserver();
    const widths: Array<[number, number, number]> = [];
    const renderPage: RenderPageFn = (page, _canvas, cssWidth, pixelRatio) => {
      widths.push([page, cssWidth, pixelRatio]);
      return Promise.resolve();
    };
    const handle = mountPageRenderer({ sections, renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    await flush();

    expect(widths).toEqual([[1, 800, 2]]);
    expect(handle.rendered()).toEqual([1]);
  });

  it('releases a canvas more than 8 pages from the nearest visible section, and draws it again on approach', async () => {
    const { sections, observer, renderer, handle } = mount(20);

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    expect(handle.rendered()).toEqual([1]);

    // Scrolled away: page 1 is now 11 pages from the only visible section.
    observer.leave(1);
    observer.enter(12);
    expect(handle.rendered()).toEqual([]);
    expect(sections[0].canvas.width).toBe(0);
    expect(sections[0].canvas.height).toBe(0);
    renderer.pending[1].resolve();
    await flush();
    expect(handle.rendered()).toEqual([12]);

    // Back again: a released canvas is re-drawn rather than left blank.
    observer.leave(12);
    observer.enter(1);
    renderer.pending[2].resolve();
    await flush();

    expect(renderer.calls).toEqual([1, 12, 1]);
    expect(handle.rendered()).toEqual([1]);
  });

  it('keeps a canvas 8 pages away: the release rule is strictly beyond, not at', async () => {
    const { observer, renderer, handle } = mount(20);

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    observer.leave(1);
    observer.enter(9); // exactly 8 pages from page 1

    expect(handle.rendered()).toEqual([1]);
  });

  it('keeps at most two renders in flight, starting the next as one finishes', async () => {
    const { observer, renderer } = mount(6);

    observer.enter(1);
    observer.enter(2);
    observer.enter(3);
    observer.enter(4);
    expect(renderer.calls).toEqual([1, 2]);

    renderer.pending[0].resolve();
    await flush();
    expect(renderer.calls).toEqual([1, 2, 3]); // FIFO: page 3 was queued before page 4

    renderer.pending[1].resolve();
    await flush();
    expect(renderer.calls).toEqual([1, 2, 3, 4]);
  });

  it('never queues the same page twice', async () => {
    const { observer, renderer } = mount(4);

    observer.enter(1);
    observer.enter(1);
    observer.enter(1);
    await flush();

    expect(renderer.calls).toEqual([1]);
  });

  it("a page whose render rejects shows its passages' text instead, and only that page", async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    mountPageRenderer({ sections, renderPage: renderer.renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    renderer.pending[0].reject(new Error('canvas context lost'));
    await flush();

    expect(sections[0].section.classList.contains('jd-render-failed')).toBe(true);
    const failed = sections[0].blocks.map((b) => b.el);
    expect(failed.every((el) => el.classList.contains('jd-block-text'))).toBe(true);
    expect(failed[0].textContent).toBe('First passage of page one, long enough to be one.');
    expect(sections[1].section.classList.contains('jd-render-failed')).toBe(false);
    expect(sections[1].blocks[0].el.textContent).toBe('');
  });

  it('keeps a highlight tag the panel had already put on an overlay when the page fails', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    const tag = document.createElement('span');
    tag.className = 'jd-rtag';
    tag.textContent = 'method · 95%';
    sections[0].blocks[0].el.appendChild(tag);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    mountPageRenderer({ sections, renderPage: renderer.renderPage, observe: observer.factory, onResize: noResize, pixelRatio: () => 2 });

    observer.enter(1);
    renderer.pending[0].reject(new Error('canvas context lost'));
    await flush();

    // The element never changes identity (a running judge still owns it) and keeps its tag.
    expect(sections[0].blocks[0].el.querySelector('.jd-rtag')).toBe(tag);
    expect(sections[0].blocks[0].el.textContent).toContain('First passage of page one');
  });

  it('re-renders a drawn page when its width moves by more than a quarter, and not otherwise', async () => {
    const container = document.createElement('main');
    const { sections } = render(DOC, PAGES, container);
    setWidth(sections[0].section, 800);
    const observer = fakeObserver();
    const renderer = fakeRenderer();
    let fireResize = (): void => {};
    mountPageRenderer({
      sections,
      renderPage: renderer.renderPage,
      observe: observer.factory,
      onResize: (_s, run) => {
        fireResize = run;
        return { disconnect: () => {} };
      },
      pixelRatio: () => 2,
    });

    observer.enter(1);
    renderer.pending[0].resolve();
    await flush();
    expect(renderer.calls).toEqual([1]);

    setWidth(sections[0].section, 900); // +12.5 %: the browser's own scaling is good enough
    fireResize();
    expect(renderer.calls).toEqual([1]);

    setWidth(sections[0].section, 1200); // +50 %: redraw at the new width
    fireResize();
    expect(renderer.calls).toEqual([1, 1]);
  });

  it('destroy stops the observers and the queue', async () => {
    const { observer, renderer, handle } = mount(6);

    observer.enter(1);
    observer.enter(2);
    observer.enter(3);
    handle.destroy();
    renderer.pending[0].resolve();
    await flush();

    expect(renderer.calls).toEqual([1, 2]); // the queued page 3 never starts
    observer.enter(4); // the fake's notify is gone after disconnect
    expect(renderer.calls).toEqual([1, 2]);
  });
});
