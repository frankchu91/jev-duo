// Popup script for the Manifest V3 action popup. Bundled as an IIFE by esbuild (scripts/build.mjs)
// and loaded by popup.html. This is the only UI in the extension that ever sees a full `Settings`
// (see messages.ts's getState doc comment on why raw keys are only ever surfaced here), lets the user
// compile/recompile a QuestionPack, and shows the running DuoStats.
//
// `initPopup` takes `doc` explicitly rather than reaching for the global `document`, so tests can pass
// a detached, parsed document without touching jsdom's own global — see tests/unit/extension/popup.test.ts.

import type { DuoStats } from '../../core/duo';
import type { QuestionPack } from '../../core/types';
import { send, type Response, type Settings } from '../messages';

const DEBOUNCE_MS = 300;
const STATS_REFRESH_MS = 2000;

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const RULE_GLYPH: Record<string, string> = { fold: '⚡', dim: '◐', badge: '◦' };

const MODEL_PLACEHOLDER: Record<Settings['providerMode'], string> = {
  mock: 'not used in mock mode',
  openrouter: 'e.g. anthropic/claude-3.5-haiku',
  typesafe: 'e.g. claude-3-5-haiku-20241022 (optional; needs an Anthropic key)',
};

/** Every id here is baked into popup.html, so a miss means the two have drifted apart — fail loudly
 * rather than silently no-op on a null element. */
function $<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`popup: missing #${id}`);
  return found as T;
}

/** Trailing-edge debounce: only the last call within `ms` of quiet fires. Used for free-text inputs
 * (intent, llm-model) so every keystroke doesn't trigger a setSettings round trip / agent rebuild. */
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Re-entrancy guard for a submit-style button: a click is ignored while any button in `buttons` is
 * already disabled (covers both a literal double-click and, for Compile/Recompile, one blocking the
 * other since both mutate the same compiled pack). Disables every button in the group for the duration
 * of `task`, always re-enabling in a `finally` even if `task` throws/rejects. */
function guardClick(buttons: HTMLButtonElement[], task: () => Promise<void>): () => void {
  return () => {
    if (buttons.some((b) => b.disabled)) return;
    for (const b of buttons) b.disabled = true;
    void task().finally(() => {
      for (const b of buttons) b.disabled = false;
    });
  };
}

function renderRules(doc: Document, listEl: HTMLElement, pack: QuestionPack | undefined): void {
  listEl.textContent = '';
  if (!pack) return;
  for (const r of pack.rules) {
    const li = doc.createElement('li');
    li.textContent = `${RULE_GLYPH[r.action] ?? '•'} ${r.label} · ${r.question} · ${pct(r.threshold)}`;
    listEl.appendChild(li);
  }
  for (const k of pack.keeps) {
    const li = doc.createElement('li');
    li.textContent = `★ ${k.label} · ${k.question} · ${pct(k.threshold)}`;
    listEl.appendChild(li);
  }
}

export async function initPopup(doc: Document, deps: { send: typeof send }): Promise<void> {
  const { send } = deps;

  const versionEl = doc.getElementById('v');
  if (versionEl && typeof chrome !== 'undefined') versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const intentEl = $<HTMLTextAreaElement>(doc, 'intent');
  const compileBtn = $<HTMLButtonElement>(doc, 'compile');
  const compileStatusEl = $(doc, 'compile-status');
  const rulesEl = $(doc, 'rules');
  const strictnessEl = $<HTMLInputElement>(doc, 'strictness');
  const strictnessValueEl = $(doc, 'strictness-value');
  const brainStatusEl = $(doc, 'brain-status');
  const providerEl = $<HTMLSelectElement>(doc, 'provider');
  const fieldOpenrouterEl = $(doc, 'field-openrouter');
  const fieldTypesafeEl = $(doc, 'field-typesafe');
  const fieldAnthropicEl = $(doc, 'field-anthropic');
  const keyOpenrouterEl = $<HTMLInputElement>(doc, 'key-openrouter');
  const keyTypesafeEl = $<HTMLInputElement>(doc, 'key-typesafe');
  const keyAnthropicEl = $<HTMLInputElement>(doc, 'key-anthropic');
  const llmModelEl = $<HTMLInputElement>(doc, 'llm-model');
  const arbiterEl = $<HTMLInputElement>(doc, 'arbiter');
  const siteXEl = $<HTMLInputElement>(doc, 'site-x');
  const siteRedditEl = $<HTMLInputElement>(doc, 'site-reddit');
  const siteHnEl = $<HTMLInputElement>(doc, 'site-hn');
  const statsEl = $(doc, 'stats');
  const examplesEl = $(doc, 'examples');
  const recompileBtn = $<HTMLButtonElement>(doc, 'recompile');
  const resetBtn = $<HTMLButtonElement>(doc, 'reset-stats');
  const mockHintEl = $(doc, 'mock-hint');

  function updateProviderUI(mode: Settings['providerMode']): void {
    fieldOpenrouterEl.hidden = mode !== 'openrouter';
    fieldTypesafeEl.hidden = mode !== 'typesafe';
    fieldAnthropicEl.hidden = mode !== 'typesafe';
    mockHintEl.hidden = mode !== 'mock';
    llmModelEl.placeholder = MODEL_PLACEHOLDER[mode];
  }

  function updateStrictnessDisplay(): void {
    strictnessValueEl.textContent = pct(Number(strictnessEl.value));
  }

  function fillSettings(s: Settings): void {
    intentEl.value = s.intent;
    strictnessEl.value = String(s.strictness);
    updateStrictnessDisplay();
    providerEl.value = s.providerMode;
    keyOpenrouterEl.value = s.keys.openrouter ?? '';
    keyTypesafeEl.value = s.keys.typesafe ?? '';
    keyAnthropicEl.value = s.keys.anthropic ?? '';
    llmModelEl.value = s.llmModel ?? '';
    arbiterEl.checked = s.arbiter;
    siteXEl.checked = s.enabledSites.x;
    siteRedditEl.checked = s.enabledSites.reddit;
    siteHnEl.checked = s.enabledSites.hn;
    updateProviderUI(s.providerMode);
    renderRules(doc, rulesEl, s.pack);
  }

  function fillStats(stats: DuoStats, exampleCount: number): void {
    statsEl.textContent =
      `judged ${stats.judged} · folded ${stats.folded} · kept ${stats.kept} · ` +
      `errors ${stats.errors} · p50 ${Math.round(stats.p50LatencyMs)}ms · ~$${stats.estimatedUsd.toFixed(4)}`;
    examplesEl.textContent = `${exampleCount} corrections`;
  }

  function setCompileStatus(text: string, isError: boolean): void {
    compileStatusEl.textContent = text;
    compileStatusEl.classList.toggle('error', isError);
  }

  function handleCompileResult(res: Response, verb: string): void {
    if (res.ok && (res.type === 'compile' || res.type === 'recompile')) {
      renderRules(doc, rulesEl, res.pack);
      setCompileStatus(`${verb} ${res.pack.rules.length} rules, ${res.pack.keeps.length} keeps`, false);
    } else if (!res.ok) {
      setCompileStatus(res.error, true);
    }
  }

  // Set once if the very first `getState` (below) fails, so the popup doesn't silently look like a
  // fresh install forever: the next `refresh()` that succeeds re-fills every control from real
  // settings (not just the read-only stats it normally touches), then clears this so later ticks go
  // back to their normal stats-only refresh.
  let loadFailed = false;

  /** Re-fetches state. Normally refreshes only the read-only displays (stats/examples/brain status) —
   * never the input controls, since a periodic tick or a Reset click must not clobber whatever the
   * user is mid-editing in the intent box or the settings fields — unless the initial load never
   * populated those controls in the first place (`loadFailed`), in which case this does that catch-up
   * fill exactly once. */
  async function refresh(): Promise<void> {
    const res = await send({ type: 'getState' });
    if (!res.ok || res.type !== 'getState') return;
    if (loadFailed) {
      fillSettings(res.settings);
      setCompileStatus('', false); // clear the stale "couldn't reach the extension" message now that it's recovered
      loadFailed = false;
    }
    fillStats(res.stats, res.exampleCount);
    brainStatusEl.textContent = `fast brain: ${res.providers.jev} · slow brain: ${res.providers.llm}`;
  }

  const patchSettings = (patch: Partial<Settings>): void => {
    void send({ type: 'setSettings', patch });
  };
  const currentSites = (): Settings['enabledSites'] => ({ x: siteXEl.checked, reddit: siteRedditEl.checked, hn: siteHnEl.checked });

  // Compile and Recompile both mutate the one compiled pack, so a click on either disables both (not
  // just itself) until the request settles — otherwise a double-click, or a Recompile fired mid-Compile,
  // would queue up duplicate LLM calls in a live provider mode.
  compileBtn.addEventListener(
    'click',
    guardClick([compileBtn, recompileBtn], async () => {
      setCompileStatus('compiling…', false);
      const res = await send({ type: 'compile', intent: intentEl.value });
      handleCompileResult(res, 'compiled');
    }),
  );
  recompileBtn.addEventListener(
    'click',
    guardClick([compileBtn, recompileBtn], async () => {
      setCompileStatus('recompiling…', false);
      const res = await send({ type: 'recompile' });
      handleCompileResult(res, 'recompiled');
    }),
  );
  resetBtn.addEventListener(
    'click',
    guardClick([resetBtn], async () => {
      await send({ type: 'resetStats' });
      await refresh();
    }),
  );

  const debouncedIntent = debounce((v: string) => patchSettings({ intent: v }), DEBOUNCE_MS);
  const debouncedModel = debounce((v: string) => patchSettings({ llmModel: v }), DEBOUNCE_MS);
  intentEl.addEventListener('input', () => debouncedIntent(intentEl.value));
  llmModelEl.addEventListener('input', () => debouncedModel(llmModelEl.value));

  strictnessEl.addEventListener('input', updateStrictnessDisplay);
  strictnessEl.addEventListener('change', () => {
    updateStrictnessDisplay();
    patchSettings({ strictness: Number(strictnessEl.value) });
  });

  providerEl.addEventListener('change', () => {
    const mode = providerEl.value as Settings['providerMode'];
    updateProviderUI(mode);
    patchSettings({ providerMode: mode });
  });

  // Keys save on `change` (blur/commit), never on every keystroke of a password field.
  keyOpenrouterEl.addEventListener('change', () => patchSettings({ keys: { openrouter: keyOpenrouterEl.value } }));
  keyTypesafeEl.addEventListener('change', () => patchSettings({ keys: { typesafe: keyTypesafeEl.value } }));
  keyAnthropicEl.addEventListener('change', () => patchSettings({ keys: { anthropic: keyAnthropicEl.value } }));

  arbiterEl.addEventListener('change', () => patchSettings({ arbiter: arbiterEl.checked }));
  siteXEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));
  siteRedditEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));
  siteHnEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));

  const initial = await send({ type: 'getState' });
  if (initial.ok && initial.type === 'getState') {
    fillSettings(initial.settings);
    fillStats(initial.stats, initial.exampleCount);
    brainStatusEl.textContent = `fast brain: ${initial.providers.jev} · slow brain: ${initial.providers.llm}`;
  } else {
    // Controls are left exactly as popup.html renders them (nothing here disables anything) — still
    // usable, just not yet filled with real settings — and the next successful `refresh()` tick will
    // catch up via `loadFailed`, so the popup recovers on its own instead of needing a manual reopen.
    loadFailed = true;
    const message = !initial.ok ? initial.error : 'unexpected response from the extension';
    setCompileStatus(`couldn't reach the extension: ${message} — reopen the popup`, true);
  }

  const timer = setInterval(() => void refresh(), STATS_REFRESH_MS);
  // `doc.defaultView` is null for a detached document (e.g. one built via DOMParser in tests, which per
  // spec has no browsing context); falling back to `doc` itself keeps this correct in the real popup (a
  // live document's defaultView is its window, where `unload` actually fires) while staying testable (a
  // test can dispatch a plain `Event('unload')` at `doc` directly).
  (doc.defaultView ?? doc).addEventListener('unload', () => clearInterval(timer));
}

// Auto-wire when actually running as the extension popup. Guarded so importing this module in a test
// (jsdom's `document` exists, but no `chrome` global unless a test stubs one) never runs it.
if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  void initPopup(document, { send }).catch((err: unknown) => console.error('jev-duo popup: init failed', err));
}
