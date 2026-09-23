// The PDF reader page (design addendum §6.3). It exists because an injected content script cannot do
// two things this page can: fetch a cross-origin PDF with a host permission, and ask for that
// permission from a click. Everything after "bytes -> passages" is the same code the injected reader
// runs — reading/reader-ui.ts for the panel, reading/run.ts for the judging — so both readers behave
// identically once there is something to read.
//
// The PDF bytes never leave the browser (§11): only the extracted passages, the title and the lead
// are ever sent, to the same provider the rest of the extension uses.
//
// The pure pieces below (status text, `isFetchableUrl`, `arxivHtmlUrl`, `render`) are exported and
// unit-tested directly (tests/unit/extension/reader-page.test.ts, jsdom, no chrome stub needed).
// Everything that touches chrome.*, fetch or pdf.js lives inside `wireUp`, called only when this is
// really running as the extension page (see the guard at the bottom) — importing this module for its
// pure exports must never reach for a DOM it did not build or fire off a real fetch.

import * as pdfjsLib from 'pdfjs-dist';
import { LEAD_MAX, TITLE_MAX, passageId, type DocContext } from '../../core/reading';
import { send } from '../messages';
import type { ArticlePassage } from '../reading/article';
import { loadPages, type PdfjsLike } from '../reading/pdf-load';
import { pagesToBlocks, type PdfDoc } from '../reading/pdf-text';
import { mountReader, type ReaderHandle } from '../reading/reader-ui';
import { runReading } from '../reading/run';

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

/** Renders a parsed PdfDoc into `container` (cleared first): an `h1` for the title, a `div.jd-page-mark`
 * before each page's first block (page 1 included — `lastPage` starts at 0, which no real page number
 * equals), a `h2.jd-heading` per heading block and a `p.jd-passage` per passage block. A doc whose blocks
 * are all headings (or which has none at all) returns an empty array — the scanned-PDF case `read()`
 * reports as `NO_TEXT_STATUS` rather than mounting an empty reader. Takes its container explicitly so
 * it is testable with a bare element, without the rest of the page. */
export function render(doc: PdfDoc, container: HTMLElement): ArticlePassage[] {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = doc.title;
  container.appendChild(h1);

  const passages: ArticlePassage[] = [];
  let lastPage = 0;
  for (const block of doc.blocks) {
    if (block.page !== lastPage) {
      lastPage = block.page;
      const mark = document.createElement('div');
      mark.className = 'jd-page-mark';
      mark.textContent = `p. ${block.page}`;
      container.appendChild(mark);
    }
    if (block.kind === 'heading') {
      const h2 = document.createElement('h2');
      h2.className = 'jd-heading';
      h2.textContent = block.text;
      container.appendChild(h2);
      continue;
    }
    const p = document.createElement('p');
    p.className = 'jd-passage';
    p.dataset.index = String(passages.length);
    p.dataset.page = String(block.page);
    p.textContent = block.text;
    container.appendChild(p);
    passages.push({ id: passageId(block.text), index: passages.length, text: block.text, page: block.page, el: p });
  }
  return passages;
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

  const src = new URLSearchParams(location.search).get('src') ?? undefined;

  let bytes: ArrayBuffer | undefined;
  let sourceName = src ?? '';
  let handle: ReaderHandle | undefined;

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

  async function read(): Promise<void> {
    if (!bytes) return;
    handle?.destroy();
    handle = undefined;
    setStatus('reading…');

    let doc: PdfDoc;
    let passages: ArticlePassage[];
    try {
      // A COPY: pdf.js transfers the typed array it is given to its worker, which detaches the buffer —
      // and the Read button re-reads the same document with a new focus.
      const { pages, metaTitle } = await loadPages(bytes.slice(0), pdfjs);
      doc = pagesToBlocks(pages, metaTitle ?? fileNameOf(sourceName));
      passages = render(doc, docEl);
    } catch (err) {
      // A corrupt file, a PDF pdf.js refuses without a password, or an HTML interstitial served at a
      // `.pdf` URL all reject here rather than resolving — caught so the status recovers instead of
      // sticking on "reading…" forever, and so the failure never escapes as an unhandled rejection.
      setStatus(parseErrorStatus(err), true);
      return;
    }
    if (passages.length === 0) {
      setStatus(NO_TEXT_STATUS, true);
      return;
    }

    const ctx: DocContext = { title: doc.title.slice(0, TITLE_MAX), lead: passages[0].text.slice(0, LEAD_MAX), source: sourceName };
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
    bytes = data;
    sourceName = url;
    await read();
  }

  fileEl.addEventListener('change', () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    void (async () => {
      // A picked file never touches the network at all, which is also the answer for file:// URLs
      // (§13): the picker is how you read one. The picker itself is never disabled, so it stays usable
      // after a failure — pick again and this fires again.
      bytes = await file.arrayBuffer();
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
