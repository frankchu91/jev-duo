// The reading panel and the passage decorations (design addendum §8.2). Shared by the reader injected
// into a page (read-page.ts) and the PDF reader page (reader/reader.ts), which is why it takes the
// host Document explicitly and speaks only DOM: no chrome.*, no messaging, no fetch. Judging happens
// in reading/run.ts and arrives here one verdict at a time through `apply`.
//
// Nothing is ever hidden (§2): a dimmed passage stays exactly where it was at 35 % opacity and comes
// back on hover, and one button brings all of them back at once. Highlights add, never remove.

import { JEV_INPUT_USD_PER_MTOK } from '../../core/constants';
import type { ReadingVerdict } from '../../core/reading';
import type { ArticlePassage } from './article';

/** The document-level sheet: the passage classes live in the page's own DOM, so they cannot live in
 * the panel's shadow root. `!important` throughout because the host page's CSS is not ours. */
export const READER_CSS = `
.jd-hl { box-shadow: inset 3px 0 0 #f2a900 !important; background: rgba(242,169,0,.10) !important; }
.jd-dim { opacity: .35 !important; transition: opacity .15s ease; }
.jd-dim:hover { opacity: 1 !important; }
.jd-flash { animation: jd-flash 1.2s ease-out 1; }
@keyframes jd-flash { from { outline: 2px solid #f2a900; outline-offset: 2px; } to { outline: 2px solid rgba(242,169,0,0); outline-offset: 2px; } }
.jd-rtag { font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important; color: #6b6b73 !important; background: #f0f0f3 !important; border-radius: 4px !important; margin-left: 6px !important; padding: 1px 6px !important; white-space: nowrap !important; vertical-align: middle !important; }
#jd-reader { position: fixed !important; right: 16px; bottom: 16px; z-index: 2147483647 !important; }
`;

/** The panel's own sheet, inside its shadow root: not exported because nothing outside this file can
 * reach the elements it styles, and `all: initial` is what keeps the host page's CSS out. */
const PANEL_CSS = `
:host { all: initial; }
.panel { width: 320px; max-height: 50vh; display: flex; flex-direction: column; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #35353c; background: #fff; border: 1px solid #dcdce2; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; }
header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #dcdce2; }
header h2 { font-size: 12px; margin: 0; flex: 1; }
button { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid #c8c8d0; background: #f0f0f3; color: #35353c; cursor: pointer; }
.x { border: none; background: none; font-size: 14px; line-height: 1; padding: 0 2px; }
.meta { color: #6b6b73; margin: 0; padding: 4px 10px; }
.meta:empty { display: none; }
ol { flex: 1; overflow-y: auto; margin: 0; padding: 0 10px 6px 26px; }
li { padding: 3px 0; cursor: pointer; }
li:hover { text-decoration: underline; }
footer { display: flex; gap: 8px; padding: 6px 10px; border-top: 1px solid #dcdce2; }
@media (prefers-color-scheme: dark) {
  .panel { color: #d6d6dc; background: #1c1c20; border-color: #3a3a41; }
  header, footer { border-color: #3a3a41; }
  button { background: #26262b; color: #d6d6dc; border-color: #3a3a41; }
  .meta { color: #a4a4ac; }
}
`;

export interface ReaderHandle {
  apply(v: ReadingVerdict): void;
  /** The background owns `Settings.focus`, so the panel learns it from the first reply (§9). */
  setFocus(focus: string): void;
  setProgress(judged: number, total: number): void;
  finish(summary: { ms: number; usageTokens: number; errors: number }): void;
  /** Idempotent: a second call is a no-op (no double `onClose`, nothing removed twice). */
  destroy(): void;
  /** True once `destroy()` has run. `runReading` polls this to stop feeding a closed reader — see
   * `apply`/`setFocus`/`setProgress`/`finish` below, which all no-op once this is true. */
  isDestroyed(): boolean;
}

const STYLE_ID = 'jd-reader-style';
const PANEL_ID = 'jd-reader';
const FLASH_MS = 1200;
const SNIPPET_MAX = 80;

const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** At most one panel exists at a time, in one document: mounting again replaces it rather than
 * stacking two readers over the same passages. */
let current: ReaderHandle | undefined;

export function mountReader(host: Document, opts: { passages: ArticlePassage[]; focus: string; onClose(): void }): ReaderHandle {
  current?.destroy();

  const style = host.createElement('style');
  style.id = STYLE_ID;
  style.textContent = READER_CSS;
  (host.head ?? host.body).appendChild(style);

  // A LIST per id, not one passage: §3's id is fnv1a over the passage's first 300 characters, so every
  // verbatim repeat of a paragraph — a legal note, a quoted block, a boilerplate footer — shares one
  // id. Keeping only the last of them gave that one element every tag and left its twins plain, and
  // every list row scrolled to it. The document's order is the insertion order here.
  const byId = new Map<string, ArticlePassage[]>();
  for (const passage of opts.passages) {
    const group = byId.get(passage.id);
    if (group) group.push(passage);
    else byId.set(passage.id, [passage]);
  }
  // The judge returns one verdict per passage, so a group of N copies produces N identical verdicts;
  // the first one decorates the whole group and the rest are nothing new to do.
  const applied = new Set<string>();
  const tags: Element[] = [];
  const dimmed: Element[] = [];
  const listedIndexes: number[] = [];
  let showingAll = false;
  // Set once destroy() has run. A batch still in flight when the user closes the panel (Close/×, or a
  // second injection toggling it off) must not keep decorating the page after its style sheet is gone
  // — every mutating method below checks this first, and destroy() itself uses it to stay idempotent.
  let destroyed = false;
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();

  const panel = host.createElement('div');
  panel.id = PANEL_ID;
  const shadow = panel.attachShadow({ mode: 'open' });

  const panelStyle = host.createElement('style');
  panelStyle.textContent = PANEL_CSS;

  const wrap = host.createElement('div');
  wrap.className = 'panel';
  const head = host.createElement('header');
  const heading = host.createElement('h2');
  heading.textContent = 'jev-duo reader';
  const closeX = host.createElement('button');
  closeX.type = 'button';
  closeX.className = 'x';
  closeX.textContent = '×';
  head.append(heading, closeX);

  const focusLine = host.createElement('p');
  focusLine.className = 'meta focus';
  const progressLine = host.createElement('p');
  progressLine.className = 'meta progress';
  const list = host.createElement('ol');

  const foot = host.createElement('footer');
  const showAll = host.createElement('button');
  showAll.type = 'button';
  showAll.textContent = 'Show all';
  const close = host.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  foot.append(showAll, close);

  wrap.append(head, focusLine, progressLine, list, foot);
  shadow.append(panelStyle, wrap);
  host.body.appendChild(panel);

  function addToList(passage: ArticlePassage, v: ReadingVerdict): void {
    // SNIPPET_MAX caps the whole "<kind> · <text>" label (so every list item reads as roughly the
    // same width regardless of whether a kind is present), not the passage text on its own — the page
    // prefix below is added after, and is not part of the cap.
    const full = v.kind ? `${v.kind} · ${passage.text}` : passage.text;
    const label = full.slice(0, SNIPPET_MAX) + (full.length > SNIPPET_MAX ? '…' : '');
    const li = host.createElement('li');
    li.textContent = passage.page === undefined ? label : `p. ${passage.page} · ${label}`;
    li.addEventListener('click', () => {
      // jsdom has no scrollIntoView, and neither does every embedded browser view — the panel must
      // still flash the passage when it cannot scroll to it.
      passage.el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      passage.el.classList.add('jd-flash');
      // Tracked so destroy() can cancel it: a flash outliving the panel by up to FLASH_MS would strip
      // `jd-flash` off whatever the SAME element ends up with next — a fresh flash from a second mount,
      // if the user reopens the reader on the same document before the timer fires.
      const timer = setTimeout(() => {
        flashTimers.delete(timer);
        passage.el.classList.remove('jd-flash');
      }, FLASH_MS);
      flashTimers.add(timer);
    });

    // Verdicts arrive in whatever order the calls resolved; the list is always document order.
    const at = listedIndexes.findIndex((index) => index > passage.index);
    if (at === -1) {
      listedIndexes.push(passage.index);
      list.appendChild(li);
    } else {
      listedIndexes.splice(at, 0, passage.index);
      list.insertBefore(li, list.children[at]);
    }
  }

  function apply(v: ReadingVerdict): void {
    if (destroyed) return; // a verdict for a panel that is already gone: nothing left to decorate
    const group = byId.get(v.id);
    if (!group) return; // a verdict for a document that has already been replaced
    if (applied.has(v.id)) return; // the same verdict again, for another copy of an identical passage
    applied.add(v.id);
    if (v.verdict === 'highlight') {
      // Every copy is highlighted and listed — one tag and one row each, so the outline can take you
      // to the third occurrence of a repeated paragraph rather than always the last.
      for (const passage of group) {
        passage.el.classList.add('jd-hl');
        const tag = host.createElement('span');
        tag.className = 'jd-rtag';
        tag.textContent = v.kind ? `${v.kind} · ${pct(v.p)}` : pct(v.p);
        passage.el.appendChild(tag);
        tags.push(tag);
        addToList(passage, v);
      }
      return;
    }
    if (v.verdict !== 'dim') return; // plain passages are left exactly as the document rendered them
    for (const passage of group) {
      dimmed.push(passage.el);
      if (!showingAll) passage.el.classList.add('jd-dim');
    }
  }

  showAll.addEventListener('click', () => {
    showingAll = !showingAll;
    for (const el of dimmed) el.classList.toggle('jd-dim', !showingAll);
    showAll.textContent = showingAll ? 'Dim again' : 'Show all';
  });

  function destroy(): void {
    if (destroyed) return; // idempotent: a second Close click, or destroy() racing a second mountReader
    destroyed = true;
    for (const timer of flashTimers) clearTimeout(timer);
    flashTimers.clear();
    for (const passage of opts.passages) passage.el.classList.remove('jd-hl', 'jd-dim', 'jd-flash');
    for (const tag of tags) tag.remove();
    panel.remove();
    style.remove();
    if (current === handle) current = undefined;
    opts.onClose();
  }

  closeX.addEventListener('click', destroy);
  close.addEventListener('click', destroy);

  const handle: ReaderHandle = {
    apply,
    setFocus(focus: string): void {
      if (destroyed) return;
      const trimmed = focus.trim();
      focusLine.textContent = trimmed === '' ? '' : `focus: ${trimmed}`;
    },
    setProgress(judged: number, total: number): void {
      if (destroyed) return;
      progressLine.textContent = `${judged} of ${total} judged`;
    },
    finish(summary): void {
      if (destroyed) return;
      const usd = ((summary.usageTokens * JEV_INPUT_USD_PER_MTOK) / 1e6).toFixed(4);
      const errors = summary.errors > 0 ? ` · ${summary.errors} errors` : '';
      progressLine.textContent = `${opts.passages.length} passages · ${(summary.ms / 1000).toFixed(1)} s · ~$${usd}${errors}`;
    },
    destroy,
    isDestroyed: () => destroyed,
  };

  handle.setFocus(opts.focus);
  current = handle;
  return handle;
}
