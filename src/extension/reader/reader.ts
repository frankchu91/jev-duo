// The PDF reader page (design addendum §6.3). It exists because an injected content script cannot do
// two things this page can: fetch a cross-origin PDF with a host permission, and ask for that
// permission from a click. Everything after "bytes -> passages" is the same code the injected reader
// runs — reading/reader-ui.ts for the panel, reading/run.ts for the judging — so both readers behave
// identically once there is something to read.
//
// The PDF bytes never leave the browser (§11): only the extracted passages, the title and the lead
// are ever sent, to the same provider the rest of the extension uses.
//
// The pure pieces below (status text, `isFetchableUrl`, `arxivHtmlUrl`) are exported and unit-tested
// directly (tests/unit/extension/reader-page.test.ts, jsdom, no chrome stub needed); the page they
// build lives in ./pages.ts and is tested the same way. Everything that touches chrome.*, fetch or
// pdf.js lives inside `wireUp`, called only when this is really running as the extension page.

import * as pdfjsLib from 'pdfjs-dist';
import { LEAD_MAX, TITLE_MAX, type DocContext } from '../../core/reading';
import { send } from '../messages';
import type { ArticlePassage } from '../reading/article';
import { openPdf, type OpenedPdf, type PdfAssets, type PdfjsLike } from '../reading/pdf-load';
import { pagesToBlocks, type PdfDoc } from '../reading/pdf-text';
import { mountReader, type ReaderHandle } from '../reading/reader-ui';
import { runReading } from '../reading/run';
import { mountPageRenderer, render, type PageRenderer } from './pages';

// pdf.js's own types are far more specific than loadPages needs; one cast at the boundary keeps a
// pdfjs-dist patch release from being able to break `pnpm typecheck`.
const pdfjs = pdfjsLib as unknown as PdfjsLike;

export const NO_TEXT_STATUS = 'no text found in this PDF (scanned pages need OCR, which jev-duo does not do)';
export const NOT_A_PDF_URL_STATUS = 'not a PDF URL';

/** `Error#message` when there is one, else the stringified value — pdf.js and the Fetch/File APIs all
 * reject with plain Errors, but nothing stops some other value from arriving here. */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The status line for a load/parse failure (a corrupt file, a PDF pdf.js refuses without a password,
 * an HTML interstitial served at a `.pdf` URL, ...): shown instead of leaving the status stuck on
 * "reading…" forever. */
export const parseErrorStatus = (err: unknown): string => `can't read this PDF: ${errMessage(err)}`;

const fileNameOf = (name: string): string => name.split(/[/\\]/).pop() || name;

/** Only an absolute http(s) URL is worth handing to `fetch`: a `file:` URL reports its `origin` as the
 * literal string "null" (so the permission-fallback status would misleadingly read "can't fetch this
 * file from null"), and an empty or relative `src` would silently re-fetch this very page instead of
 * failing. Used once, up front, before `?src=` is ever handed to `load`. */
export function isFetchableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** arXiv's `/pdf/<id>` has an HTML twin at `/html/<id>` that keeps real paragraphs; a PDF only has
 * glyph positions. `<id>` is the rest of the path exactly as given, minus a trailing `.pdf`. Reads
 * `url.hostname` (not `.host`, which would also carry a port) so this gate cannot drift from the
 * popup's `looksLikePdf`, which gates the same way on the same field. */
export function arxivHtmlUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'arxiv.org' || !url.pathname.startsWith('/pdf/')) return undefined;
  const id = url.pathname.slice('/pdf/'.length).replace(/\.pdf$/i, '');
  return id === '' ? undefined : `https://arxiv.org/html/${id}`;
}

/** §5.3's runtime assets, from the extension's own origin: the standard 14 fonts so a PDF set in Times
 * is not blank, the cmaps so CJK-encoded text extracts, the wasm decoders so JPX/JBIG2 images render.
 * A function rather than a constant because `chrome.runtime` does not exist when this module is merely
 * imported by a test. */
function pdfAssets(): PdfAssets {
  return {
    standardFontDataUrl: chrome.runtime.getURL('standard_fonts/'),
    cMapUrl: chrome.runtime.getURL('cmaps/'),
    cMapPacked: true,
    wasmUrl: chrome.runtime.getURL('wasm/'),
  };
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`reader: missing #${id}`);
  return found as T;
}

/** Everything that touches chrome.*, fetch or pdf.js: bound to the real page's elements, called once,
 * only when this really is the extension's reader page (see the guard below). */
function wireUp(): void {
  // Loaded from the extension's own origin, which the default extension CSP allows.
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

  const sourceEl = $('source');
  const hintEl = $('arxiv-hint');
  const focusEl = $<HTMLInputElement>('focus');
  const readBtn = $<HTMLButtonElement>('read');
  const statusEl = $('status');
  const allowBtn = $<HTMLButtonElement>('allow');
  const fileEl = $<HTMLInputElement>('file');
  const docEl = $('doc');
  const backEl = $<HTMLAnchorElement>('back');

  const src = new URLSearchParams(location.search).get('src') ?? undefined;

  let bytes: ArrayBuffer | undefined;
  let sourceName = src ?? '';
  let handle: ReaderHandle | undefined;
  // The document stays OPEN for as long as it is on screen: its canvases are drawn from it on demand,
  // and Read re-judges it with a new focus without re-fetching, re-parsing or re-rendering (§5.3).
  let opened: OpenedPdf | undefined;
  let renderer: PageRenderer | undefined;
  let passages: ArticlePassage[] = [];
  let title = '';

  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function renderHint(): void {
    const html = src === undefined ? undefined : arxivHtmlUrl(src);
    if (!html) {
      hintEl.hidden = true;
      return;
    }
    hintEl.hidden = false;
    hintEl.textContent = 'arXiv also publishes an HTML version of most papers: ';
    const link = document.createElement('a');
    link.href = html;
    link.textContent = 'open it';
    hintEl.append(link, ', then click Read this page — HTML gives better paragraphs than a PDF.');
  }

  /** §4. Only a reader that REPLACED something has something to go back to: a picker-only reader, or
   * one opened in a fresh tab from the popup's hint link, does not — and Chrome's own PDF viewer is
   * exactly one entry back in that tab's history, because `chrome.tabs.update` navigated it. */
  function renderBack(): void {
    backEl.hidden = !(src !== undefined && history.length > 1);
  }

  backEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    history.back();
  });

  /** §6.3's permission fallback. `chrome.permissions.request` needs a user gesture, so it can only ever
   * be called from this click handler — never from the load path that discovered the problem. */
  function offerPermission(url: string): void {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      setStatus(`can't fetch this file from ${url}`, true);
      return;
    }
    setStatus(`can't fetch this file from ${origin}`, true);
    allowBtn.hidden = false;
    allowBtn.textContent = `Allow access to ${origin}`;
    allowBtn.onclick = (): void => {
      void (async () => {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
        if (!granted) {
          setStatus('permission declined', true);
          return;
        }
        allowBtn.hidden = true;
        await load(url);
      })().catch((err: unknown) => setStatus(parseErrorStatus(err), true));
    };
  }

  /** arXiv serves `access-control-allow-origin: *`, so its PDFs load with no permission at all; a host
   * that does not is where the button above comes in. */
  async function fetchPdf(url: string): Promise<ArrayBuffer | undefined> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch {
      offerPermission(url);
      return undefined;
    }
  }

  /** Drops everything holding the current document: the panel, the canvases' observers, and the pdf.js
   * worker. Called before a new document is opened, so two are never alive at once — and clears `#doc`
   * itself, so a document that fails to open outright (below, before `render` ever runs) does not leave
   * the PREVIOUS document's pages sitting under the new one's error status. */
  async function closeDocument(): Promise<void> {
    handle?.destroy();
    handle = undefined;
    renderer?.destroy();
    renderer = undefined;
    passages = [];
    title = '';
    docEl.textContent = '';
    const previous = opened;
    opened = undefined;
    await previous?.destroy();
  }

  /** bytes -> an open document, rendered in place. Returns false, with the status already set, when
   * there is nothing to read. A document with no passages is not retained: its pdf.js document is
   * destroyed and `opened` is left undefined, so a later Read press goes through this function again
   * instead of finding `opened` truthy and reaching for a `passages[0]` that does not exist. */
  async function openDocument(data: ArrayBuffer): Promise<boolean> {
    let pdf: OpenedPdf;
    let doc: PdfDoc;
    try {
      // A COPY: pdf.js transfers the typed array it is given to its worker, which detaches the buffer.
      pdf = await openPdf(data.slice(0), pdfjs, pdfAssets());
      doc = pagesToBlocks(pdf.pages, pdf.metaTitle ?? fileNameOf(sourceName));
    } catch (err) {
      // A corrupt file, a PDF pdf.js refuses without a password, or an HTML interstitial served at a
      // `.pdf` URL all reject here rather than resolving — caught so the status recovers instead of
      // sticking on "reading…" forever, and so the failure never escapes as an unhandled rejection.
      setStatus(parseErrorStatus(err), true);
      return false;
    }
    const built = render(doc, pdf.pages, docEl);
    if (built.passages.length === 0) {
      await pdf.destroy();
      setStatus(NO_TEXT_STATUS, true);
      return false;
    }
    opened = pdf;
    passages = built.passages;
    title = doc.title;
    renderer = mountPageRenderer({
      sections: built.sections,
      renderPage: (n, canvas, cssWidth, pixelRatio) => pdf.renderPage(n, canvas, cssWidth, pixelRatio),
    });
    return true;
  }

  /** Mounts the panel over whatever is rendered and judges it. Opens the document first if it is not
   * open yet, so pressing Read again re-judges the SAME rendered pages with a new focus (§5.3): no
   * fetch, no re-parse, no re-render, and the canvases already drawn stay drawn. */
  async function read(): Promise<void> {
    handle?.destroy();
    handle = undefined;
    if (!opened) {
      const data = bytes;
      if (!data) return;
      setStatus('reading…');
      if (!(await openDocument(data))) return;
    }
    const ctx: DocContext = { title: title.slice(0, TITLE_MAX), lead: passages[0].text.slice(0, LEAD_MAX), source: sourceName };
    handle = mountReader(document, {
      passages,
      focus: focusEl.value,
      onClose: () => {
        handle = undefined;
      },
    });
    setStatus(''); // the panel owns the progress and the summary from here on
    await runReading({ handle, ctx, passages, send });
  }

  async function load(url: string): Promise<void> {
    setStatus('loading…');
    const data = await fetchPdf(url);
    if (!data) return;
    await closeDocument();
    bytes = data;
    sourceName = url;
    await read();
  }

  fileEl.addEventListener('change', () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    void (async () => {
      // A picked file never touches the network at all, which is also the answer for file:// URLs:
      // the picker is how you read one. The picker itself is never disabled, so it stays usable after
      // a failure — pick again and this fires again.
      const data = await file.arrayBuffer();
      await closeDocument();
      bytes = data;
      sourceName = file.name;
      sourceEl.textContent = file.name;
      allowBtn.hidden = true;
      await read();
    })().catch((err: unknown) => setStatus(parseErrorStatus(err), true));
  });

  readBtn.addEventListener('click', () => {
    void (async () => {
      readBtn.disabled = true;
      try {
        // Saved to settings, so the popup and this page always ask the same question.
        await send({ type: 'setSettings', patch: { focus: focusEl.value } });
        await read();
      } finally {
        readBtn.disabled = false;
      }
    })().catch((err: unknown) => setStatus(parseErrorStatus(err), true));
  });

  async function init(): Promise<void> {
    sourceEl.textContent = src ?? '';
    renderHint();
    renderBack();
    // An extension page may ask for getState; a content script may not, which is why the injected
    // reader has to wait for the focus and this one does not.
    const state = await send({ type: 'getState' });
    if (state.ok && state.type === 'getState') focusEl.value = state.settings.focus;
    if (src === undefined) {
      setStatus('open a PDF from your computer to read it');
      return;
    }
    if (!isFetchableUrl(src)) {
      // An empty `?src=` or a `file:`/relative one: rejected up front rather than handed to `fetch`,
      // whose failure modes for those are confusing (an empty string re-fetches this very page; a
      // `file:` URL's `.origin` is the literal string "null").
      setStatus(NOT_A_PDF_URL_STATUS, true);
      return;
    }
    await load(src);
  }

  void init().catch((err: unknown) => console.error('jev-duo reader: init failed', err));
}

// Auto-wire when actually running as the extension's reader page. Guarded so importing this module in
// a test (jsdom's `document` exists, but no `chrome` global unless a test stubs one) never touches
// chrome.*, fetch or pdf.js, and never registers listeners against a DOM it did not build.
if (typeof document !== 'undefined' && typeof chrome !== 'undefined') wireUp();
