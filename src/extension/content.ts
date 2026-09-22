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
/** Minimum gap between `pageSeen` reports after the initial one. A feed mutates constantly; the popup
 * only needs to know whether this page is producing posts at all, so one report per second is plenty. */
const SEEN_REPORT_MS = 1000;
/** How often the current count is re-sent even when nothing has changed. The background mirrors
 * reports to session storage, but an extension reload (or an update) starts it from an empty map
 * while this page keeps running, and a page whose count never changes — most of all a broken adapter
 * stuck at 0 — would then never be heard from again. */
const SEEN_HEARTBEAT_MS = 30_000;
/** How many times a post may extract to `null` before content.ts gives up on it and marks it seen
 * anyway. Without a cap, a post that will never be judgeable (e.g. a pure-media tweet with no
 * tweetText) gets re-extracted on every single MutationObserver scan for as long as it stays in the
 * DOM — unbounded, since findPosts() is idempotent and keeps returning it every time. */
const MAX_EXTRACT_ATTEMPTS = 5;
/** How long after a scan that found no feed before this script looks again on its own. Every other
 * scan is reactive — a DOM mutation or a visibility change — so a page whose feed renders in one
 * commit, with the adapter's full-scan throttle spending that call on an empty result, has no second
 * chance at all: the mutation that would have triggered the rescan is the very one that got throttled.
 * Two shapes hit this, which is why the retry is armed whenever the page currently shows no feed
 * rather than only while it has never produced one:
 *   - first render late (an SPA committing a second after document_idle, nothing judged yet);
 *   - feed REPLACED (an in-app navigation removes the old feed, which detaches the generic adapter's
 *     cached parent and so forces a full scan that finds nothing AND restarts the throttle window;
 *     the new view then renders inside that window and is thrown away).
 * One pending retry at a time, never armed while a scan is finding posts (`found.length > 0` then),
 * cleared in `stop()`. Matched to the generic adapter's own full-scan interval, so the retry always
 * gets a real scan rather than another throttled no-op.
 *
 * Accepted cost: a page showing no feed — empty from the start, or emptied by a navigation that never
 * renders another one — pays one scan every 5 s for as long as it stays empty and open. That is the
 * same bounded budget the adapter's own time-based throttle already permits, and far less than the
 * per-mutation full scan this whole throttle exists to remove. */
const EMPTY_RESCAN_MS = 5000;

interface Pending { el: Element; targets: Element[]; item: Item }

export function startContentScript(
  doc: Document,
  loc: Location,
  deps: { send: typeof send; debounceMs?: number; maxBatch?: number; seenReportMs?: number; seenHeartbeatMs?: number },
): { stop(): void; seen(): number } {
  const picked: Adapter | undefined = pickAdapter(new URL(loc.href));
  if (!picked) return { stop() {}, seen: () => 0 };
  const adapter = picked; // rebind so closures below see the non-undefined type, not Adapter | undefined

  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const maxBatch = deps.maxBatch ?? MAX_BATCH;
  const seenReportMs = deps.seenReportMs ?? SEEN_REPORT_MS;
  const seenHeartbeatMs = deps.seenHeartbeatMs ?? SEEN_HEARTBEAT_MS;

  // A WeakSet plus a counter, not a Set: on an infinite feed the strong Set kept every post element
  // the user ever scrolled past alive for the life of the tab, even after the site recycled it out of
  // the DOM. The count is what `seen()` and the popup report need; the elements themselves are only
  // ever asked "have I handled you before?".
  const seen = new WeakSet<Element>();
  let seenCount = 0;
  const nullAttempts = new WeakMap<Element, number>();
  const pendingById = new Map<string, Pending>();
  let batch: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  let reportedSeen = -1; // -1, not 0, so the very first report goes out even when the page has no posts
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
        // `wrapBar` lets an adapter put the fold bar somewhere its own markup allows (HN's feed is a
        // <table>, where a bare <div> between rows is not); adapters without one get the bar as is.
        mountDecision(p.el, p.targets, p.item, verdict.decision, handlers, adapter.wrapBar);
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

  /** Tells the background how many posts this page has produced, so the popup can say "0 posts seen
   * on this page" when a site's DOM has changed under an adapter (spec §8). Sends only when the count
   * has changed, unless `force` (the heartbeat below, which re-states an unchanged count). */
  function reportSeen(force = false): void {
    if (!force && seenCount === reportedSeen) return;
    reportedSeen = seenCount;
    void deps.send({ type: 'pageSeen', platform: adapter.platform, seen: seenCount });
  }

  /** Trailing-edge, at most one pending: a feed that streams posts in must not turn into one message
   * per mutation. The initial report is sent directly by the caller, un-debounced. */
  function scheduleSeenReport(): void {
    if (seenTimer !== undefined || stopped) return;
    seenTimer = setTimeout(() => {
      seenTimer = undefined;
      reportSeen();
    }, seenReportMs);
  }

  function queue(el: Element, targets: Element[], item: Item): void {
    // Two elements can carry the same item id (X renders a quoted/reposted tweet twice). Keying
    // `pendingById` by id alone meant the second one overwrote the first, whose targets then kept
    // their pending marker forever; the duplicate is simply skipped instead, staying fully visible.
    if (pendingById.has(item.id)) return;
    pendingById.set(item.id, { el, targets, item });
    // The id the adapter derived, on the post it came from: the only way to find a specific item in a
    // live feed (generic ids are content hashes), which is how the e2e keys its fixture probabilities
    // off real ids. Written once, never read back by this script.
    el.setAttribute('data-jd-id', item.id);
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
        if (!item) {
          // Not judgeable yet: retry on later scans (text may still be rendering) up to the cap, then
          // give up for good — mark it seen so it stops costing a findPosts+extract pass forever.
          const attempts = (nullAttempts.get(el) ?? 0) + 1;
          if (attempts >= MAX_EXTRACT_ATTEMPTS) { seen.add(el); seenCount += 1; }
          else nullAttempts.set(el, attempts);
          continue;
        }
        seen.add(el);
        seenCount += 1;
        queue(el, adapter.targets(el), item);
      } catch {
        // one broken post must not stop the rest of the scan, or be marked seen (so it never recovers)
      }
    }
    // No feed in front of us right now — whether or not this page has produced posts before — so give
    // it another look on our own (see EMPTY_RESCAN_MS). Re-armed by each empty scan; a scan that finds
    // posts arms nothing, and the page goes back to being driven by its own mutations.
    if (found.length === 0) armRescan();
  }

  /** Arms the single pending self-rescan, if one isn't already armed. */
  function armRescan(): void {
    if (rescanTimer !== undefined || stopped) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined;
      if (stopped) return;
      scan();
      scheduleSeenReport(); // a feed that turned up in that scan is news for the popup too
    }, EMPTY_RESCAN_MS);
  }

  function scheduleScan(): void {
    if (rafScheduled || stopped) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (stopped) return;
      scan();
      scheduleSeenReport();
    });
  }

  scan();
  reportSeen(); // the initial scan's count goes out at once: zero posts is exactly what the popup needs to hear
  const heartbeat = setInterval(() => reportSeen(true), seenHeartbeatMs);
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
      if (seenTimer !== undefined) { clearTimeout(seenTimer); seenTimer = undefined; }
      if (rescanTimer !== undefined) { clearTimeout(rescanTimer); rescanTimer = undefined; }
      clearInterval(heartbeat);
    },
    seen: () => seenCount,
  };
}

interface BootDeps {
  doc: Document;
  loc: Location;
  send: typeof send;
  start: typeof startContentScript;
}

/** Real auto-start's decision logic, factored out so it can be driven by a fake `send` and a spy
 * `start` in tests instead of the real `chrome.runtime`/DOM globals. Checked once at load: a disabled
 * site (or an unreadable one, the request failing) is a full no-op, never even reaching `start`.
 *
 * Asks `isSiteEnabled`, never `getState`: getState's reply carries the user's raw API keys, and this
 * code runs in the page's world. The background refuses getState from a tab for the same reason. */
export async function boot(deps: BootDeps): Promise<void> {
  const adapter = pickAdapter(new URL(deps.loc.href));
  if (!adapter) return;
  const res = await deps.send({ type: 'isSiteEnabled', platform: adapter.platform, origin: deps.loc.origin });
  if (!res.ok || res.type !== 'isSiteEnabled') return; // can't confirm enabled: stay out of the way
  if (!res.enabled) return;
  deps.start(deps.doc, deps.loc, { send: deps.send });
}

/** The flag one injection of this script leaves behind for the next one, on the isolated world every
 * content script of this extension shares within a frame. */
const STARTED_FLAG = '__jevDuoStarted';

/** Boots at most once per frame. A site the user enabled can be matched by BOTH the manifest's static
 * `content_scripts` entry and its own dynamic registration (the e2e's patched manifest is exactly that
 * case, and so is any future manifest addition of a site someone had already opted into), and Chrome
 * then injects this bundle twice into the same page — two MutationObservers, two scans, two judge
 * batches for every post. The flag is set SYNCHRONOUSLY, before the async `boot`, so a second
 * injection that lands while the first is still awaiting `isSiteEnabled` still sees it.
 *
 * `scope` defaults to the real global; tests pass a plain object instead of mutating it. */
export async function startOnce(
  deps: BootDeps,
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): Promise<boolean> {
  if (scope[STARTED_FLAG]) return false;
  scope[STARTED_FLAG] = true;
  await boot(deps);
  return true;
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  void startOnce({ doc: document, loc: location, send, start: startContentScript }).catch((err: unknown) =>
    console.error('jev-duo content script: boot failed', err),
  );
}
