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
// queued — the content script depends on it being fast) but snapshots `agent`/`cache` into locals up
// front and never re-reads the closure after an `await`, so a concurrent rebuild can't make it persist
// the wrong instance's stats. setSettings/resetStats/compile/recompile/feedback all mutate shared state
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
import type { Request, Response, Settings } from './messages';
import { loadExamples, loadSettings, loadStats, loadVerdicts, MAX_VERDICTS, saveExamples, saveSettings, saveStats, saveVerdicts } from './storage';

interface Resolved {
  jev: JevProvider;
  llm: LlmProvider;
  hasKeys: boolean;
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

export function createBackground(deps: { fetchImpl?: typeof fetch } = {}): { handle(req: Request): Promise<Response>; ready: Promise<void> } {
  let settings: Settings;
  let agent: DuoAgent;
  let hasKeys = false;
  let providers: { jev: string; llm: string } = { jev: 'mock', llm: 'mock' };
  let cache: LruCache<Verdict>;

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
    const [loadedSettings, loadedExamples, verdictEntries] = await Promise.all([loadSettings(), loadExamples(), loadVerdicts()]);
    await loadStats(); // loaded for parity with settings/examples; DuoAgent has no counter-seeding hook to feed it into
    cache = new LruCache<Verdict>(MAX_VERDICTS);
    // settings/agent are assigned BEFORE the cache warm below: loadVerdicts() already filters to
    // well-formed entries, but the warm is still wrapped in its own try/catch so that even an
    // unforeseen failure here can never leave `agent` undefined for the rest of this handler's life.
    settings = loadedSettings;
    agent = await buildAgent(loadedSettings, ExampleStore.fromJSON(loadedExamples));
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
    const currentCache = cache;
    if (!current.pack) return { ok: false, error: 'no pack compiled yet' };

    const task = (async (): Promise<Response> => {
      const verdicts = await current.judge(items);
      await Promise.all([saveStats(current.stats()), saveVerdicts(currentCache.entries())]);
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
    const saved = await saveSettings(patch);

    await waitForInFlightJudges(); // let any judge still using the OLD agent/cache finish first

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

  async function dispatch(req: Request): Promise<Response> {
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
        return { ok: true, type: 'getState', settings, stats: agent.stats(), exampleCount: agent.examples.size, hasKeys, providers };
      case 'setSettings':
        return enqueueMutation(() => handleSetSettings(req.patch));
      case 'resetStats':
        return enqueueMutation(() => handleResetStats());
      default:
        return { ok: false, error: `unknown request type: ${(req as { type: string }).type}` };
    }
  }

  async function handle(req: Request): Promise<Response> {
    try {
      await ready;
      return await dispatch(req);
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
  chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse) => {
    background
      .handle(req)
      .catch((err: unknown): Response => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then(sendResponse);
    return true; // keep the message channel open for the async sendResponse above
  });
}
