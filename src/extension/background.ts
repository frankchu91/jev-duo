// Service worker (Manifest V3, `type: module`). Owns the one and only DuoAgent instance and is the
// only place in the extension that ever calls an LLM/Jev provider directly — a browser-page fetch to
// the TypeSafe API is rejected by CORS, but a service worker with host permissions is exempt. The
// content script and popup only ever reach this through messages.ts's typed Request/Response contract.
//
// Service workers can be killed and restarted by Chrome at any time, so nothing here assumes warm
// module state: createBackground() initialises lazily (the `ready` promise) and every handler awaits
// it before touching `agent`/`settings`/`cache`.

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

export function createBackground(deps: { fetchImpl?: typeof fetch } = {}): { handle(req: Request): Promise<Response>; ready: Promise<void> } {
  let settings: Settings;
  let agent: DuoAgent;
  let hasKeys = false;
  let cache: LruCache<Verdict>;

  async function buildAgent(nextSettings: Settings, examples: ExampleStore): Promise<DuoAgent> {
    const resolved = resolveForSettings(nextSettings, deps.fetchImpl);
    hasKeys = resolved.hasKeys;
    return new DuoAgent({
      jev: resolved.jev,
      llm: resolved.llm,
      pack: nextSettings.pack,
      settings: { strictness: nextSettings.strictness, arbiter: nextSettings.arbiter },
      examples,
      cache,
    });
  }

  /** Rebuilds the agent from `nextSettings`, carrying over the live example store and the shared
   * verdict cache. Used by setSettings (providers may have changed) and resetStats (the only way to
   * zero DuoAgent's counters is a fresh instance — it has no stats-seeding hook). Both are a full
   * `new DuoAgent(...)`, so both also reset the live (not persisted) stats as a side effect. */
  async function rebuildAgent(nextSettings: Settings): Promise<void> {
    const examples = agent.examples;
    settings = nextSettings;
    agent = await buildAgent(nextSettings, examples);
  }

  async function init(): Promise<void> {
    const [loadedSettings, loadedExamples, verdictEntries] = await Promise.all([loadSettings(), loadExamples(), loadVerdicts()]);
    await loadStats(); // loaded for parity with settings/examples; DuoAgent has no counter-seeding hook to feed it into
    cache = new LruCache<Verdict>(MAX_VERDICTS);
    for (const [key, verdict] of verdictEntries) cache.set(key, verdict);
    settings = loadedSettings;
    agent = await buildAgent(loadedSettings, ExampleStore.fromJSON(loadedExamples));
  }

  const ready = init().catch((err: unknown) => {
    console.error('jev-duo background: init failed', err);
  });

  async function recompileAgent(): Promise<QuestionPack> {
    const pack = await agent.recompile();
    settings = await saveSettings({ intent: pack.intent, pack });
    return pack;
  }

  async function handleJudge(items: Item[]): Promise<Response> {
    if (!agent.pack) return { ok: false, error: 'no pack compiled yet' };
    const verdicts = await agent.judge(items);
    await Promise.all([saveStats(agent.stats()), saveVerdicts(cache.entries())]);
    return { ok: true, type: 'judge', verdicts };
  }

  async function handleCompile(intent: string): Promise<Response> {
    const pack = await agent.compile(intent);
    settings = await saveSettings({ intent, pack });
    return { ok: true, type: 'compile', pack };
  }

  async function handleFeedback(example: Example): Promise<Response> {
    const { shouldRecompile } = agent.feedback(example);
    await saveExamples(agent.examples.toJSON());
    if (shouldRecompile) await recompileAgent();
    return { ok: true, type: 'feedback', recompiled: shouldRecompile, exampleCount: agent.examples.size };
  }

  async function handleSetSettings(patch: Partial<Settings>): Promise<Response> {
    const saved = await saveSettings(patch);
    await rebuildAgent(saved);
    return { ok: true, type: 'setSettings' };
  }

  async function handleResetStats(): Promise<Response> {
    await rebuildAgent(settings);
    await saveStats(agent.stats());
    return { ok: true, type: 'resetStats' };
  }

  async function dispatch(req: Request): Promise<Response> {
    switch (req.type) {
      case 'judge':
        return handleJudge(req.items);
      case 'compile':
        return handleCompile(req.intent);
      case 'recompile':
        return { ok: true, type: 'recompile', pack: await recompileAgent() };
      case 'feedback':
        return handleFeedback(req.example);
      case 'getState':
        return { ok: true, type: 'getState', settings, stats: agent.stats(), exampleCount: agent.examples.size, hasKeys };
      case 'setSettings':
        return handleSetSettings(req.patch);
      case 'resetStats':
        return handleResetStats();
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
