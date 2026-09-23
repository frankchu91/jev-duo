// @vitest-environment jsdom
//
// Unit coverage for reader.ts's WIREUP behaviour — the document-lifecycle state machine
// (closeDocument/openDocument/read, and the `opened` it juggles) that only runs once chrome.* exists
// (see reader.ts's guard at the bottom). Unlike reader-page.test.ts (pure exports only, no chrome stub,
// by design — see its own header) this file installs a chrome stub and mocks `../reading/pdf-load`'s
// `openPdf` (never real pdf.js), then re-imports reader.ts fresh with `vi.resetModules()` so its
// top-level auto-wire guard fires against the CURRENT stub and DOM — the same pattern
// background.test.ts's "module top-level wiring" describe block uses for background.ts's own
// onMessage auto-registration.
//
// Driven entirely through the file picker (never `?src=`), so `location.search` never needs touching.
// `messages.ts`'s `send()` never rejects (it resolves `{ok:false,...}` when nothing is listening), so
// the parts of wireUp that call it (init's getState, Read's setSettings) run harmlessly against a
// chrome stub with no background attached.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenedPdf } from '../../../src/extension/reading/pdf-load';
import { installChromeStub } from './chrome-stub';

const openPdfMock = vi.fn();
vi.mock('../../../src/extension/reading/pdf-load', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extension/reading/pdf-load')>();
  return { ...actual, openPdf: (...args: unknown[]) => openPdfMock(...args) };
});

/** Set by the one test that needs the step AFTER `openPdf` to fail. Everything else in pdf-text stays
 * real — the fixtures below depend on the actual block extraction — and so does `pagesToBlocks` itself
 * whenever this is undefined. */
let parseOverride: (() => never) | undefined;
vi.mock('../../../src/extension/reading/pdf-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extension/reading/pdf-text')>();
  return {
    ...actual,
    pagesToBlocks: (...args: Parameters<typeof actual.pagesToBlocks>) => (parseOverride ? parseOverride() : actual.pagesToBlocks(...args)),
  };
});

const NO_TEXT_STATUS = 'no text found in this PDF (scanned pages need OCR, which jev-duo does not do)';

/** A one-page OpenedPdf whose page has no text items at all — the scanned-PDF case: `pagesToBlocks`
 * (real, unmocked) yields zero passage blocks from it, so `render` yields zero passages too. */
function emptyOpenedPdf(): OpenedPdf {
  return {
    pages: [{ page: 1, width: 612, height: 792, originX: 0, originY: 0, rotation: 0, items: [] }],
    renderPage: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

/** A one-page OpenedPdf with one real, long-enough text item, so `pagesToBlocks` yields exactly one
 * passage block — enough for `read()` to reach `mountReader`/`runReading` rather than bailing early. */
function oneTextOpenedPdf(): OpenedPdf {
  return {
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        originX: 0,
        originY: 0,
        rotation: 0,
        items: [{ str: 'This paragraph has comfortably more than forty characters in it.', x: 72, y: 700, size: 10, width: 400, rotated: false }],
      },
    ],
    renderPage: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

/** reader.html's body, minus the script tag: enough for `wireUp`'s `$(id)` lookups to find everything. */
function mountReaderDom(): void {
  document.body.innerHTML = `
    <header class="jd-head">
      <a id="back" class="jd-back" href="#" hidden>← Back to the PDF</a>
      <p id="source" class="jd-source"></p>
      <p id="arxiv-hint" class="jd-hint" hidden></p>
      <div class="jd-row">
        <input type="text" id="focus" />
        <button id="read" type="button">Read</button>
      </div>
      <div class="jd-row">
        <span id="status" class="jd-status"></span>
        <button id="allow" type="button" hidden></button>
      </div>
      <div class="jd-row">
        <label for="file">Open a PDF from your computer</label>
        <input type="file" id="file" accept="application/pdf" />
      </div>
    </header>
    <main id="doc"></main>
  `;
}

/** Fires reader.ts's auto-wire guard against the CURRENT chrome stub and DOM: `resetModules()` forces
 * a fresh top-level evaluation, since vitest's module cache would otherwise just hand back the module
 * from a previous test, whose `wireUp()` already ran against a document that no longer exists. */
async function loadReader(): Promise<void> {
  vi.resetModules();
  await import('../../../src/extension/reader/reader');
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** `fileEl.files` is read-only in a real browser; jsdom lets a test override it directly. */
function pickFile(name: string, bytes = '%PDF-1.4 fake'): void {
  const file = new File([bytes], name, { type: 'application/pdf' });
  Object.defineProperty(el('file'), 'files', { value: [file], configurable: true });
  el('file').dispatchEvent(new Event('change'));
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const status = (): string => el('status').textContent ?? '';
const docChildren = (): number => el('doc').children.length;
const pageSections = (): HTMLElement[] => [...el('doc').querySelectorAll<HTMLElement>('section.jd-page')];

/** jsdom has no IntersectionObserver at all, so pages.ts's default lazy-canvas observer is a no-op
 * there — which is also the only handle a test has on whether the page renderer was mounted. This
 * stand-in records what was observed and lets `show()` report all of it as visible, which is what makes
 * the canvases draw. Its sections need a width too: `draw` skips a section it measures at 0 px, and
 * jsdom measures everything at 0. */
function installIntersectionObserver(): { show(): void } {
  type Entry = { target: Element; isIntersecting: boolean };
  const observed: Element[] = [];
  let fire: ((entries: Entry[]) => void) | undefined;
  class FakeIntersectionObserver {
    constructor(callback: (entries: Entry[]) => void) {
      fire = callback;
    }
    observe(target: Element): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      fire = undefined;
    }
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
  return {
    show: () => {
      for (const target of observed) Object.defineProperty(target, 'clientWidth', { value: 800, configurable: true });
      fire?.(observed.map((target) => ({ target, isIntersecting: true })));
    },
  };
}

describe('reader.ts wireUp (chrome-stubbed)', () => {
  beforeEach(() => {
    installChromeStub();
    mountReaderDom();
    openPdfMock.mockReset();
    parseOverride = undefined;
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    document.getElementById('jd-reader')?.remove();
  });

  // --- Review fix round 2, IMPORTANT A: a text-free PDF is a document, not an error page ---

  it('keeps a text-free document open and renders its pages, and says so again on the next Read', async () => {
    const scan = emptyOpenedPdf();
    openPdfMock.mockResolvedValueOnce(scan);
    const io = installIntersectionObserver();
    await loadReader();

    pickFile('scan.pdf');
    await flush();

    expect(status()).toBe(NO_TEXT_STATUS);
    expect(el<HTMLElement>('status').classList.contains('error')).toBe(true);
    // The page is really on screen, at its own proportions — not an empty frame under an error.
    expect(pageSections().map((s) => s.style.aspectRatio)).toEqual(['612 / 792']);
    expect(document.getElementById('jd-reader')).toBeNull(); // nothing to judge, so no panel

    // The page renderer is mounted exactly as for a document with text: the scanned page draws when it
    // nears the viewport, so it can be looked at and scrolled.
    io.show();
    await flush();
    expect(scan.renderPage).toHaveBeenCalledTimes(1);
    expect(scan.renderPage).toHaveBeenCalledWith(1, expect.any(HTMLCanvasElement), 800, expect.any(Number));

    // Read again: the same open document, the same answer. No re-fetch, no re-open, no `passages[0]`.
    el<HTMLButtonElement>('read').click();
    await flush();

    expect(status()).toBe(NO_TEXT_STATUS); // not a thrown-TypeError status, and not stuck on "reading…"
    expect(openPdfMock).toHaveBeenCalledTimes(1);
    expect(scan.destroy).not.toHaveBeenCalled();
    expect(document.getElementById('jd-reader')).toBeNull();
  });

  it('destroys a text-free document when the next document arrives, like any other', async () => {
    const scan = emptyOpenedPdf();
    const paper = oneTextOpenedPdf();
    openPdfMock.mockResolvedValueOnce(scan).mockResolvedValueOnce(paper);
    await loadReader();

    pickFile('scan.pdf');
    await flush();
    expect(scan.destroy).not.toHaveBeenCalled();

    pickFile('paper.pdf');
    await flush();

    expect(scan.destroy).toHaveBeenCalledTimes(1);
    expect(status()).toBe(''); // the panel owns the status line once there is something to read
    expect(pageSections()).toHaveLength(1); // the new document's page, not the scan's
  });

  // --- Review fix round 2, minor B: a throw after openPdf must not leak the open document ---

  it('destroys the opened document when the step after openPdf throws', async () => {
    const pdf = oneTextOpenedPdf();
    openPdfMock.mockResolvedValueOnce(pdf);
    parseOverride = () => {
      throw new Error('block extraction blew up');
    };
    await loadReader();

    pickFile('a.pdf');
    await flush();

    expect(status()).toBe("can't read this PDF: block extraction blew up");
    // Nothing else holds it: `opened` was never assigned, so closeDocument could never find it.
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
    expect(docChildren()).toBe(0); // no half-built document under the error
  });

  // --- Review fix round 1, minor 5 ---

  it("closeDocument clears #doc, so a document that fails to open doesn't leave the previous one's pages under the error", async () => {
    openPdfMock.mockResolvedValueOnce(oneTextOpenedPdf());
    await loadReader();

    pickFile('a.pdf');
    await flush();
    expect(status()).toBe(''); // the panel owns the status line once a real read starts
    expect(docChildren()).toBeGreaterThan(0); // document A's pages are in #doc

    openPdfMock.mockRejectedValueOnce(new Error('bad xref table'));
    pickFile('b.pdf', '%PDF-1.4 not really');
    await flush();

    expect(status()).toBe("can't read this PDF: bad xref table");
    expect(docChildren()).toBe(0); // A's stale pages are gone, not sitting under B's error
  });
});
