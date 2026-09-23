// The PDF reader page (design addendum §6.3). It exists because an injected content script cannot do
// two things this page can: fetch a cross-origin PDF with a host permission, and ask for that
// permission from a click. Everything after "bytes -> passages" is the same code the injected reader
// runs — reading/reader-ui.ts for the panel, reading/run.ts for the judging — so both readers behave
// identically once there is something to read.
//
// The PDF bytes never leave the browser (§11): only the extracted passages, the title and the lead
// are ever sent, to the same provider the rest of the extension uses.

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
// Loaded from the extension's own origin, which the default extension CSP allows.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`reader: missing #${id}`);
  return found as T;
}

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

const fileNameOf = (name: string): string => name.split(/[/\\]/).pop() || name;

/** arXiv's `/pdf/<id>` has an HTML twin at `/html/<id>` that keeps real paragraphs; a PDF only has
 * glyph positions. `<id>` is the rest of the path exactly as given, minus a trailing `.pdf`. */
function arxivHtmlUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.host !== 'arxiv.org' || !url.pathname.startsWith('/pdf/')) return undefined;
  const id = url.pathname.slice('/pdf/'.length).replace(/\.pdf$/i, '');
  return id === '' ? undefined : `https://arxiv.org/html/${id}`;
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
    })();
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

function render(doc: PdfDoc): ArticlePassage[] {
  docEl.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = doc.title;
  docEl.appendChild(h1);

  const passages: ArticlePassage[] = [];
  let lastPage = 0;
  for (const block of doc.blocks) {
    if (block.page !== lastPage) {
      lastPage = block.page;
      const mark = document.createElement('div');
      mark.className = 'jd-page-mark';
      mark.textContent = `p. ${block.page}`;
      docEl.appendChild(mark);
    }
    if (block.kind === 'heading') {
      const h2 = document.createElement('h2');
      h2.className = 'jd-heading';
      h2.textContent = block.text;
      docEl.appendChild(h2);
      continue;
    }
    const p = document.createElement('p');
    p.className = 'jd-passage';
    p.dataset.index = String(passages.length);
    p.dataset.page = String(block.page);
    p.textContent = block.text;
    docEl.appendChild(p);
    passages.push({ id: passageId(block.text), index: passages.length, text: block.text, page: block.page, el: p });
  }
  return passages;
}

async function read(): Promise<void> {
  if (!bytes) return;
  handle?.destroy();
  handle = undefined;
  setStatus('reading…');

  // A COPY: pdf.js transfers the typed array it is given to its worker, which detaches the buffer —
  // and the Read button re-reads the same document with a new focus.
  const { pages, metaTitle } = await loadPages(bytes.slice(0), pdfjs);
  const doc = pagesToBlocks(pages, metaTitle ?? fileNameOf(sourceName));
  const passages = render(doc);
  if (passages.length === 0) {
    setStatus('no text found in this PDF (scanned pages need OCR, which jev-duo does not do)', true);
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
    // (§13): the picker is how you read one.
    bytes = await file.arrayBuffer();
    sourceName = file.name;
    sourceEl.textContent = file.name;
    allowBtn.hidden = true;
    await read();
  })();
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
  })();
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
  await load(src);
}

void init().catch((err: unknown) => console.error('jev-duo reader: init failed', err));
