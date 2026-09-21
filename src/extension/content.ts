// Content script, bundled as an IIFE. Finds posts via the matching adapter, batches them to the
// background service worker to be judged, and folds/dims/badges them via ui/fold.ts. Fail-open is
// sacred here: any exception caught in this file leaves the post exactly as the page rendered it
// (pending marker cleared, nothing folded) rather than risk hiding something real.

import type { Decision, Item } from '../core/types';
import { pickAdapter } from './adapters';
import type { Adapter, FoldHandlers } from './adapters/types';
import { send } from './messages';
import type { Response } from './messages';
import { applyPending, clearPending, mountDecision } from './ui/fold';

const DEBOUNCE_MS = 150;
const MAX_BATCH = 10;

interface Pending { el: Element; targets: Element[]; item: Item }

export function startContentScript(
  doc: Document,
  loc: Location,
  deps: { send: typeof send; debounceMs?: number; maxBatch?: number },
): { stop(): void; seen(): number } {
  const picked: Adapter | undefined = pickAdapter(new URL(loc.href));
  if (!picked) return { stop() {}, seen: () => 0 };
  const adapter = picked; // rebind so closures below see the non-undefined type, not Adapter | undefined

  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const maxBatch = deps.maxBatch ?? MAX_BATCH;

  const seen = new Set<Element>();
  const pendingById = new Map<string, Pending>();
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rafScheduled = false;
  let stopped = false;

  function feedback(expected: 'show' | 'hide', item: Item, decision: Decision): void {
    void deps.send({ type: 'feedback', example: { item, expected, actualDecision: decision, source: 'user', at: new Date().toISOString() } });
  }
  const handlers: FoldHandlers = {
    onWrong: (item, decision) => feedback('show', item, decision),
    onHideThis: (item, decision) => feedback('hide', item, decision),
  };

  function onJudged(ids: string[], res: Response | { ok: false; error: string }): void {
    for (const id of ids) {
      const p = pendingById.get(id);
      if (!p) continue;
      pendingById.delete(id);
      clearPending(p.targets);
      if (!res.ok || res.type !== 'judge') continue; // fail open: leave visible, mount nothing
      const verdict = res.verdicts.find((v) => v.itemId === id);
      if (!verdict) continue;
      try {
        mountDecision(p.el, p.targets, p.item, verdict.decision, handlers);
      } catch {
        // a broken mount must not break the page; pending is already cleared above either way.
      }
    }
  }

  function flush(): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (batch.length === 0) return;
    const ids = batch;
    batch = [];
    const items = ids.map((id) => pendingById.get(id)?.item).filter((i): i is Item => !!i);
    if (items.length === 0) return;
    deps.send({ type: 'judge', items }).then(
      (res) => onJudged(ids, res),
      () => onJudged(ids, { ok: false, error: 'send rejected' }),
    );
  }

  function queue(el: Element, targets: Element[], item: Item): void {
    pendingById.set(item.id, { el, targets, item });
    applyPending(targets);
    batch.push(item.id);
    if (batch.length >= maxBatch) { flush(); return; }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function scan(): void {
    let found: Element[];
    try {
      found = adapter.findPosts(doc);
    } catch {
      return; // a broken findPosts must not touch the page
    }
    for (const el of found) {
      if (seen.has(el)) continue;
      try {
        const item = adapter.extract(el);
        if (!item) continue; // not judgeable yet: don't mark seen, so a later scan can retry it
        seen.add(el);
        queue(el, adapter.targets(el), item);
      } catch {
        // one broken post must not stop the rest of the scan, or be marked seen (so it never recovers)
      }
    }
  }

  function scheduleScan(): void {
    if (rafScheduled || stopped) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (!stopped) scan();
    });
  }

  scan();
  const observer = new MutationObserver(() => {
    try {
      scheduleScan();
    } catch {
      // never throw out of the MutationObserver callback
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  function onVisibilityChange(): void {
    if (doc.visibilityState === 'visible') scheduleScan();
  }
  doc.addEventListener('visibilitychange', onVisibilityChange);

  return {
    stop(): void {
      stopped = true;
      observer.disconnect();
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    },
    seen: () => seen.size,
  };
}

/** Real auto-start, skipped entirely under test (no `document`/`chrome`). Checked once at load: a
 * disabled site is a full no-op, never even reaching `startContentScript`. */
async function boot(): Promise<void> {
  const adapter = pickAdapter(new URL(location.href));
  if (!adapter) return;
  const state = await send({ type: 'getState' });
  if (!state.ok || state.type !== 'getState') return; // can't confirm enabled: stay out of the way
  if (state.settings.enabledSites[adapter.platform] === false) return;
  startContentScript(document, location, { send });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  void boot().catch((err: unknown) => console.error('jev-duo content script: boot failed', err));
}
