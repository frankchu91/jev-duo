// Service worker (Manifest V3, `type: module`). Owns the one and only DuoAgent instance and is the
// only place in the extension that ever calls an LLM/Jev provider directly — a browser-page fetch to
// the TypeSafe API is rejected by CORS, but a service worker with host permissions is exempt. The
// content script and popup only ever reach this through messages.ts's typed Request/Response contract.
//
// Service workers can be killed and restarted by Chrome at any time, so nothing here assumes warm
// module state: createBackground() initialises lazily (the `ready` promise) and every handler awaits
// it before touching `agent`/`settings`/`cache`.
//
// Concurrency: `chrome.runtime.onMessage` can dispatch several messages before any of them resolve, so
// two handlers can be mid-flight over the same closure state at once. `judge` runs immediately (never
// queued — the content script depends on it being fast) but snapshots `agent` into a local up front
// and never re-reads the closure after an `await`, so a concurrent rebuild can't make it persist the
// wrong instance's stats. setSettings/resetStats/compile/recompile/feedback all mutate shared state
// (settings, the agent's pack/examples, or the agent instance itself) and are serialised behind a
// single-flight queue so two of them never interleave; the two that actually replace the agent
// (setSettings, resetStats) additionally drain every in-flight `judge` first, so a rebuild never
// happens out from under one.

import { LruCache } from '../core/cache';
import { DuoAgent } from '../core/duo';
import { ExampleStore } from '../core/learner';
import { resolveProviders } from '../core/providers/resolve';
import type { JevProvider, LlmProvider } from '../core/providers/types';
import type { Example, Item, QuestionPack, Verdict } from '../core/types';
import type { PagePlatform, PageSeenReport, Request, Response, Sender, Settings } from './messages';
import { isValidOrigin, reconcileSites, registerSite, unregisterSite } from './sites';
import { loadExamples, loadPageSeen, loadSettings, loadStats, loadVerdicts, MAX_PAGE_REPORTS, MAX_VERDICTS, saveExamples, savePageSeen, saveSettings, saveStats, saveVerdicts } from './storage';

interface Resolved {
  jev: JevProvider;
  llm: LlmProvider;
  hasKeys: boolean;
}

/** How long a judge waits before mirroring the verdict cache to chrome.storage.session. A scroll
 * produces a judge every few hundred ms and each flush rewrites the WHOLE cache (up to MAX_VERDICTS
 * entries), so writing per judge amplifies one batch of 10 posts into one full-cache write. */
const VERDICT_FLUSH_MS = 2000;

/** `chrome-extension://<id>`, the origin every page of this extension reports as `sender.origin` —
 * the action popup, an options page, popup.html opened in a tab. Undefined only when there is no
 * usable `chrome.runtime` at all (a bare unit-test stub), which `isPageContext` treats as "unknown,
 * so assume a page". */
function extensionOrigin(): string | undefined {
  if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function') return undefined;
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

/** True when the message came from a web page rather than from this extension's own UI. A content
 * script always reports its host page's `origin`; nothing running in a page can report the
 * extension's. `tab === undefined` is the action popup / the worker itself. */
function isPageContext(sender?: Sender): boolean {
  if (sender?.tab === undefined) return false;
  const own = extensionOrigin();
  return own === undefined || sender.origin !== own;
}

/** Maps Settings.providerMode to a live jev/llm pair. Falls back to mock/mock (hasKeys:false) whenever
 * the mode's required key is missing, or resolution throws for any other reason — judge/compile must
 * stay usable even when nothing is configured yet, never throw during startup. */
function resolveForSettings(settings: Settings, fetchImpl?: typeof fetch): Resolved {
  const { providerMode, keys, llmModel, mockFixtures } = settings;
  try {
    if (providerMode === 'openrouter' && keys.openrouter) {
      const { jev, llm } = resolveProviders({ jev: 'openrouter', llm: 'openrouter', keys, llmModel, browser: true, fetchImpl, mockFixtures });
      return { jev, llm, hasKeys: true };
    }
    if (providerMode === 'typesafe' && keys.typesafe) {
      const llmMode = keys.anthropic ? 'anthropic' : 'mock';
      const { jev, llm } = resolveProviders({ jev: 'typesafe', llm: llmMode, keys, llmModel, browser: true, fetchImpl, mockFixtures });
      return { jev, llm, hasKeys: true };
    }
  } catch {
    // A key was present but resolution still failed: fall through to mock/mock below rather than
    // leave the service worker without a working agent.
  }
  const { jev, llm } = resolveProviders({ jev: 'mock', llm: 'mock', keys: {}, browser: true, fetchImpl, mockFixtures });
  return { jev, llm, hasKeys: false };
}

/** Order-sensitive equality for two origin lists: `reconcileSites` returns a sorted list, so a stored
 * list that differs only in order is treated as changed and rewritten once, sorted, and then matches. */
function sameOrigins(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((origin, i) => origin === b[i]);
}

/** True when `next` would resolve to different provider instances than `prev` (a providerMode or any
 * key change). The verdict cache key (pack.compiledAt + item.id + item.text) doesn't include the
 * provider at all, so a probability cached from one provider must never be served as if it came from
 * another — ruling (c). */
function providersMayHaveChanged(prev: Settings, next: Settings): boolean {
  return (
    prev.providerMode !== next.providerMode ||
    prev.keys.openrouter !== next.keys.openrouter ||
    prev.keys.typesafe !== next.keys.typesafe ||
    prev.keys.anthropic !== next.keys.anthropic
  );
}

export function createBackground(deps: { fetchImpl?: typeof fetch } = {}): { handle(req: Request, sender?: Sender): Promise<Response>; ready: Promise<void> } {
  let settings: Settings;
  let agent: DuoAgent;
  let hasKeys = false;
  let providers: { jev: string; llm: string } = { jev: 'mock', llm: 'mock' };
  let cache: LruCache<Verdict>;

  // Latest `pageSeen` report per tab, insertion-ordered oldest -> newest so the cap can drop the
  // least recently reporting tab. Mirrored to chrome.storage.session (and re-read by init) because
  // Chrome evicts an idle service worker after ~30 seconds, and the report the popup most needs —
  // "this page produced no posts at all" — would otherwise vanish with it.
  const pageSeen = new Map<number, { platform: PagePlatform; seen: number; at: string }>();

  // Tracks every judge() call currently in flight (from just before it starts until its stats/cache
  // are persisted), so a rebuild can wait for the set to drain instead of racing it.
  const inFlightJudges = new Set<Promise<unknown>>();

  // Single-flight queue for the mutating handlers. `mutationQueue` itself always resolves (even when a
  // queued `fn` rejects), so one failed call can never wedge every later one; `enqueueMutation`'s
  // return value is `fn`'s own promise, so a caller still sees its real outcome.
  let mutationQueue: Promise<void> = Promise.resolve();
  function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutationQueue.then(fn, fn);
    mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Trailing-edge debounce for the chrome.storage.session verdict mirror: at most one pending flush,
  // and each new judge pushes it back by VERDICT_FLUSH_MS. The timer always mirrors the CURRENT
  // `cache`, so a rebuild that replaced it (see handleSetSettings) can only ever make the flush write
  // less, never resurrect a discarded entry.
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleVerdictFlush(): void {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void saveVerdicts(cache.entries()).catch((err: unknown) => {
        console.error('jev-duo background: verdict flush failed', err);
      });
    }, VERDICT_FLUSH_MS);
  }

  /** Cancels any pending flush and performs it now. Called before anything that replaces or clears
   * the cache, so the mirror is never left behind a discarded in-memory state. */
  async function flushVerdictsNow(): Promise<void> {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
    await saveVerdicts(cache.entries());
  }

  /** Waits for every currently-tracked judge() to settle, re-checking until none are left (a new judge
   * can start while we wait, since judge is never queued behind a mutation). Never rejects: a failed
   * judge must not make an unrelated setSettings/resetStats call fail too. */
  async function waitForInFlightJudges(): Promise<void> {
    while (inFlightJudges.size > 0) {
      await Promise.allSettled([...inFlightJudges]);
    }
  }

  async function buildAgent(nextSettings: Settings, examples: ExampleStore): Promise<DuoAgent> {
    const resolved = resolveForSettings(nextSettings, deps.fetchImpl);
    hasKeys = resolved.hasKeys;
    providers = { jev: resolved.jev.name, llm: resolved.llm.name };
    return new DuoAgent({
      jev: resolved.jev,
      llm: resolved.llm,
      pack: nextSettings.pack,
      settings: { strictness: nextSettings.strictness, arbiter: nextSettings.arbiter },
      examples,
      cache,
    });
  }

  /** Rebuilds the agent from `nextSettings`, carrying over the live example store. Used by
   * setSettings (providers may have changed) and resetStats (the only way to zero DuoAgent's counters
   * is a fresh instance — it has no stats-seeding hook). Both are a full `new DuoAgent(...)`, so both
   * also reset the live (not persisted) stats as a side effect. Callers must already have drained
   * `inFlightJudges` before calling this. */
  async function rebuildAgent(nextSettings: Settings): Promise<void> {
    const examples = agent.examples;
    settings = nextSettings;
    agent = await buildAgent(nextSettings, examples);
  }

  async function init(): Promise<void> {
    const [loadedSettings, loadedExamples, verdictEntries, seenReports] = await Promise.all([loadSettings(), loadExamples(), loadVerdicts(), loadPageSeen()]);
    await loadStats(); // loaded for parity with settings/examples; DuoAgent has no counter-seeding hook to feed it into
    for (const { tabId, ...report } of seenReports) pageSeen.set(tabId, report);
    cache = new LruCache<Verdict>(MAX_VERDICTS);
    // settings/agent are assigned BEFORE the cache warm below: loadVerdicts() already filters to
    // well-formed entries, but the warm is still wrapped in its own try/catch so that even an
    // unforeseen failure here can never leave `agent` undefined for the rest of this handler's life.
    settings = loadedSettings;
    try {
      // Reconcile dynamic generic-site registrations against the permissions Chrome actually holds
      // (design §4) before anything else can see `settings` — see sites.ts's reconcileSites doc
      // comment. Wrapped the same way as the cache warm below: an unforeseen failure here (e.g. the
      // scripting/permissions APIs misbehaving) must not leave `agent` unbuilt for the rest of this
      // service worker's life. The write only happens when reconciliation actually changed the list:
      // init() runs on every service-worker wake-up, and the usual outcome is "nothing to repair".
      const genericSites = await reconcileSites(loadedSettings.genericSites);
      if (!sameOrigins(genericSites, loadedSettings.genericSites)) settings = await saveSettings({ genericSites });
    } catch (err) {
      console.error('jev-duo background: site reconciliation failed', err);
    }
    agent = await buildAgent(settings, ExampleStore.fromJSON(loadedExamples));
    try {
      for (const [key, verdict] of verdictEntries) cache.set(key, verdict);
    } catch (err) {
      console.error('jev-duo background: verdict cache warm failed', err);
    }
  }

  const ready = init().catch((err: unknown) => {
    console.error('jev-duo background: init failed', err);
  });

  async function recompileAgent(current: DuoAgent): Promise<QuestionPack> {
    const pack = await current.recompile();
    settings = await saveSettings({ intent: pack.intent, pack });
    return pack;
  }

  async function handleJudge(items: Item[]): Promise<Response> {
    const current = agent;
    if (!current.pack) return { ok: false, error: 'no pack compiled yet' };

    const task = (async (): Promise<Response> => {
      const verdicts = await current.judge(items);
      await saveStats(current.stats());
      scheduleVerdictFlush(); // the session mirror is a cache of a cache: coalescing writes is free
      return { ok: true, type: 'judge', verdicts };
    })();

    inFlightJudges.add(task);
    try {
      return await task;
    } finally {
      inFlightJudges.delete(task);
    }
  }

  async function handleCompile(intent: string): Promise<Response> {
    const current = agent;
    const pack = await current.compile(intent);
    settings = await saveSettings({ intent, pack });
    return { ok: true, type: 'compile', pack };
  }

  async function handleRecompile(): Promise<Response> {
    const current = agent;
    const pack = await recompileAgent(current);
    return { ok: true, type: 'recompile', pack };
  }

  async function handleFeedback(example: Example): Promise<Response> {
    const current = agent;
    const { shouldRecompile } = current.feedback(example);
    await saveExamples(current.examples.toJSON());
    if (shouldRecompile) {
      await recompileAgent(current);
      // recompile() just called markRecompiled() (sinceRecompile -> 0) on the SAME live store; persist
      // that too, or the stored counter goes stale until the next unrelated feedback call — ruling (d).
      await saveExamples(current.examples.toJSON());
    }
    return { ok: true, type: 'feedback', recompiled: shouldRecompile, exampleCount: current.examples.size };
  }

  async function handleSetSettings(patch: Partial<Settings>): Promise<Response> {
    const before = settings;
    // `genericSites` is owned by enableSite/disableSite alone: they are the only pair that also
    // registers/unregisters the origin's content script and holds (or hands back) its host permission,
    // and the only pair refused to a content-script sender. A setSettings patch that could add an
    // origin here would grant the adapter a site behind both of those gates, so the field is dropped
    // from every patch — the popup never sends it.
    const { genericSites: _ignoredGenericSites, ...safePatch } = patch;
    const saved = await saveSettings(safePatch);

    await waitForInFlightJudges(); // let any judge still using the OLD agent/cache finish first
    try {
      await flushVerdictsNow(); // ...and land its (debounced) mirror write before the cache can change
    } catch {
      // `saveSettings` has already committed, so throwing here would leave the persisted settings
      // ahead of the live agent until the next restart. A lost verdict-cache mirror is a cache miss;
      // a skipped rebuild is the popup and the content script disagreeing about the settings.
    }

    if (providersMayHaveChanged(before, saved)) {
      // The verdict cache key carries no provider identity, so a probability cached under the old
      // provider must never be served once the provider has changed — discard both the in-memory
      // cache and its chrome.storage.session mirror.
      cache = new LruCache<Verdict>(MAX_VERDICTS);
      await saveVerdicts([]);
    }

    await rebuildAgent(saved);
    return { ok: true, type: 'setSettings' };
  }

  async function handleResetStats(): Promise<Response> {
    await waitForInFlightJudges();
    await rebuildAgent(settings);
    await saveStats(agent.stats());
    return { ok: true, type: 'resetStats' };
  }

  /** Registers `origin`'s dynamic content script (updating it in place if already registered — see
   * sites.ts), then adds it to `settings.genericSites` (sorted, unique: enabling an already-enabled
   * origin is a no-op past the register-or-update step). */
  async function handleEnableSite(origin: string): Promise<Response> {
    if (!isValidOrigin(origin)) return { ok: false, error: 'invalid origin' };
    await registerSite(origin);
    const genericSites = [...new Set([...settings.genericSites, origin])].sort();
    settings = await saveSettings({ genericSites });
    return { ok: true, type: 'enableSite', genericSites: settings.genericSites };
  }

  /** Unregisters `origin`'s dynamic content script and releases its host permission (both in sites.ts,
   * which owns every chrome.scripting/chrome.permissions call the worker makes; the permission release
   * is best-effort there), then drops it from `settings.genericSites`. */
  async function handleDisableSite(origin: string): Promise<Response> {
    if (!isValidOrigin(origin)) return { ok: false, error: 'invalid origin' };
    await unregisterSite(origin);
    const genericSites = settings.genericSites.filter((o) => o !== origin);
    settings = await saveSettings({ genericSites });
    return { ok: true, type: 'disableSite', genericSites: settings.genericSites };
  }

  /** Records one content script's post count for its tab, dropping the least recently reporting tab
   * once the cap is reached (delete-then-set keeps insertion order == recency), and mirrors the
   * result to session storage so it outlives this service worker. A failed mirror write is logged
   * and swallowed: the live map is still correct, and losing a report is not worth failing on. */
  async function recordPageSeen(tabId: number, platform: PagePlatform, seen: number): Promise<void> {
    pageSeen.delete(tabId);
    pageSeen.set(tabId, { platform, seen, at: new Date().toISOString() });
    while (pageSeen.size > MAX_PAGE_REPORTS) {
      const oldest = pageSeen.keys().next().value;
      if (oldest === undefined) break;
      pageSeen.delete(oldest);
    }
    try {
      await savePageSeen(pageSeenReports());
    } catch (err) {
      console.error('jev-duo background: page-seen mirror write failed', err);
    }
  }

  function pageSeenReports(): PageSeenReport[] {
    return [...pageSeen].map(([tabId, report]) => ({ tabId, ...report }));
  }

  async function dispatch(req: Request, sender?: Sender): Promise<Response> {
    switch (req.type) {
      case 'judge':
        return handleJudge(req.items);
      case 'compile':
        return enqueueMutation(() => handleCompile(req.intent));
      case 'recompile':
        return enqueueMutation(() => handleRecompile());
      case 'feedback':
        return enqueueMutation(() => handleFeedback(req.example));
      case 'getState':
        return { ok: true, type: 'getState', settings, stats: agent.stats(), exampleCount: agent.examples.size, hasKeys, providers, pageSeen: pageSeenReports() };
      case 'isSiteEnabled': {
        const { platform } = req;
        // A generic origin is opt-in and off by default (fail-closed): enabled only once the user's
        // origin is exactly in genericSites. The three built-ins keep their existing default-on gate.
        if (platform === 'generic') {
          return { ok: true, type: 'isSiteEnabled', enabled: req.origin !== undefined && settings.genericSites.includes(req.origin) };
        }
        // The only state a page context may ask for, and deliberately one boolean wide.
        return { ok: true, type: 'isSiteEnabled', enabled: settings.enabledSites[platform] !== false };
      }
      case 'pageSeen':
        // No tab id (e.g. driven through the test hook rather than onMessage): nothing to key on, so
        // the report is acknowledged and dropped rather than failing the content script's send.
        if (sender?.tab?.id !== undefined) await recordPageSeen(sender.tab.id, req.platform, req.seen);
        return { ok: true, type: 'pageSeen' };
      case 'setSettings':
        return enqueueMutation(() => handleSetSettings(req.patch));
      case 'resetStats':
        return enqueueMutation(() => handleResetStats());
      case 'enableSite':
        return enqueueMutation(() => handleEnableSite(req.origin));
      case 'disableSite':
        return enqueueMutation(() => handleDisableSite(req.origin));
      default:
        return { ok: false, error: `unknown request type: ${(req as { type: string }).type}` };
    }
  }

  async function handle(req: Request, sender?: Sender): Promise<Response> {
    try {
      // Defence in depth for the keys in `Settings`: a content script shares its world with the page.
      // It never needs getState (it asks `isSiteEnabled`), so the request is refused outright rather
      // than answered with a redacted copy — a rejection can't be mistaken for real settings by
      // future code. Refusing is also the fallback when the origin can't be established at all.
      if (req.type === 'getState' && isPageContext(sender)) {
        return { ok: false, error: 'getState is not available to content scripts' };
      }
      // Same rule, same reason, for the two requests that change which sites are enabled: a page must
      // never be able to grant itself (or any other origin) the adapter just by sending a message.
      if ((req.type === 'enableSite' || req.type === 'disableSite') && isPageContext(sender)) {
        return { ok: false, error: `${req.type} is not available to content scripts` };
      }
      await ready;
      return await dispatch(req, sender);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { handle, ready };
}

// Auto-wire the singleton background when actually running as an extension service worker. Guarded so
// importing this module in a test (no `chrome` global, or a stub with nothing listening yet) never
// throws — the module itself must be safe to load before anyone has wired up messaging.
if (typeof chrome !== 'undefined') {
  const background = createBackground();
  // Test hook: chrome.runtime.sendMessage never delivers to the sender's own context, so the e2e
  // suite drives the background through this handle instead (tests/e2e/helpers.ts).
  (globalThis as unknown as { __jevDuo?: typeof background }).__jevDuo = background;
  chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
    background
      .handle(req, sender)
      .catch((err: unknown): Response => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then(sendResponse);
    return true; // keep the message channel open for the async sendResponse above
  });
}
