// The shared reading loop (design addendum §8.1 and §6.3): passages go to the background in document
// order, in batches. Both readers — the one injected into a page and the PDF reader page — run exactly
// this, which is the only reason the two produce the same panel from the same judgments.
//
// TWO PHASES (addendum 2026-09-23 §2.3). Verdicts used to be applied as each batch answered; they are
// now collected, and the document is decorated only once every batch is in. Highlights are the top
// share of the WHOLE document (rankReading), so no verdict can be decided while passages are still
// unjudged — a passage that looks like the best of the first twelve is often nowhere near the best of
// two hundred. What the reader sees while it waits is the progress line, which was always there.
//
// This is the only file under reading/ that knows about messaging; reader-ui.ts stays pure DOM.

import { rankReading, type DocContext, type Passage, type ReadingVerdict } from '../../core/reading';
import type { send } from '../messages';
import type { ReaderHandle } from './reader-ui';

/** Twelve passages per message: small enough that the panel fills in while a long document is still
 * being read, large enough that a 600-passage document is 50 messages rather than 600. */
export const READ_BATCH = 12;

export async function runReading(deps: {
  handle: ReaderHandle;
  ctx: DocContext;
  passages: Passage[];
  send: typeof send;
  batchSize?: number;
  now?: () => number;
}): Promise<{ ms: number; usageTokens: number; errors: number; lastError?: string }> {
  const { handle, ctx, passages } = deps;
  const size = deps.batchSize ?? READ_BATCH;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  let judged = 0;
  let usageTokens = 0;
  let errors = 0;
  // §3.1: the FIRST reason in batch order, not the last — the first batch to fail is the one that
  // explains the run (a stale service worker answers every later batch identically anyway).
  let lastError: string | undefined;
  let focusShown = false;
  // Every verdict of this document, in batch order, plus the two things the background decides that the
  // ranking needs: whether a focus was applied at all, and how big a share of the document to highlight.
  const collected: ReadingVerdict[] = [];
  let focus = '';
  let highlightShare: number | undefined;

  handle.setProgress(0, passages.length);
  for (let i = 0; i < passages.length; i += size) {
    // The reader can be closed (Close/×, or a popup toggle-off re-running read-page.ts) while a batch
    // is still in flight — a 10 s per-passage timeout on the judge means "in flight" can last a while.
    // Checked before every send, so a closed reader never issues another message...
    if (handle.isDestroyed()) break;
    // Rebuilt field by field, which is also what strips an ArticlePassage's `el`: a DOM node cannot
    // be structured-cloned into a message, and the background has no use for one.
    const batch = passages.slice(i, i + size).map(({ id, index, text, page }) => ({ id, index, text, page }));
    const res = await deps.send({ type: 'readPassages', ctx, passages: batch });
    // ...and again right after: a reply that lands after the close is discarded rather than applied —
    // `apply`/`setFocus`/`setProgress` would no-op anyway (reader-ui.ts), but skipping here also stops
    // this loop from ever reaching another `send`.
    if (handle.isDestroyed()) break;
    if (res.ok && res.type === 'readPassages') {
      if (!focusShown) {
        handle.setFocus(res.focus);
        focus = res.focus;
        highlightShare = res.highlightShare;
        focusShown = true;
      }
      collected.push(...res.verdicts);
      usageTokens += res.usageTokens;
      errors += res.errors;
      if (lastError === undefined && res.lastError !== undefined) lastError = res.lastError;
    } else {
      // Fail open (§2): a batch the background could not answer leaves its passages exactly as the
      // document rendered them, counted so the summary line admits it.
      errors += batch.length;
      // `!res.ok` is what narrows `res` to the error variant — the ok variant always has this type.
      if (lastError === undefined && !res.ok) lastError = res.error;
    }
    judged += batch.length;
    handle.setProgress(judged, passages.length);
  }

  const summary = { ms: now() - started, usageTokens, errors, lastError };
  // A destroyed reader has nothing left to show a summary on; `finish` would no-op anyway, but the
  // panel is gone either way, so there's no reason to touch it — and a document whose loop was cut
  // short is never ranked, because the share it would be ranked against was never fully judged.
  if (handle.isDestroyed()) return summary;
  // Phase two: one ranking over the whole document, then one pass of decoration. `apply` still takes
  // the first verdict per id and ignores the rest, which is exactly right — every id is applied once
  // here, and a document that repeats a paragraph verbatim hands the same id to each copy.
  for (const verdict of rankReading(collected, focus.trim() !== '', highlightShare)) handle.apply(verdict);
  handle.finish(summary);
  return summary;
}
