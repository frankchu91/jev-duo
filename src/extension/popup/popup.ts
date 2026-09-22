// Popup script for the Manifest V3 action popup. Bundled as an IIFE by esbuild (scripts/build.mjs)
// and loaded by popup.html. This is the only UI in the extension that ever sees a full `Settings`
// (see messages.ts's getState doc comment on why raw keys are only ever surfaced here), lets the user
// compile/recompile a QuestionPack, and shows the running DuoStats.
//
// `initPopup` takes `doc` explicitly rather than reaching for the global `document`, so tests can pass
// a detached, parsed document without touching jsdom's own global — see tests/unit/extension/popup.test.ts.

import type { DuoStats } from '../../core/duo';
import type { QuestionPack } from '../../core/types';
import { isBuiltInHost } from '../built-in-hosts';
import { send, type PageSeenReport, type Response, type Settings } from '../messages';

const DEBOUNCE_MS = 300;
const STATS_REFRESH_MS = 2000;

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const RULE_GLYPH: Record<string, string> = { fold: '⚡', dim: '◐', badge: '◦' };

const MODEL_PLACEHOLDER: Record<Settings['providerMode'], string> = {
  mock: 'not used in mock mode',
  openrouter: 'e.g. anthropic/claude-opus-5',
  typesafe: 'e.g. claude-opus-5 (needs an Anthropic key)',
};

const NO_PAGE_REPORT = 'no page report yet';
const ZERO_SEEN = "0 posts seen on this page — the site's layout may have changed";

/** The active tab, used to pick this window's `pageSeen` report out of getState (by `id`) and to drive
 * the This-site section (by `url`, readable while the popup is open thanks to `activeTab`).
 * `tabs.query` needs no `tabs` permission for either field here. Returns undefined outside a real
 * extension popup (the unit tests' detached document) or if the query fails, which renders as
 * "no page report yet" / "not a web page". */
async function activeTab(): Promise<{ id?: number; url?: string } | undefined> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch {
    return undefined;
  }
}

/** The tab's URL as a `URL`, or undefined when it is not an http(s) page (`chrome://`, `about:`, an
 * extension page) or not parseable at all — exactly the cases This site calls "not a web page". */
function parseHttpUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The outcome of asking Chrome for one origin: granted, declined, or the call itself failing (an
 * invalidated extension context, a prompt Chrome refuses to show because the gesture was already
 * spent). The third case must not look like a decline — nothing was asked. */
type PermissionOutcome = { ok: true; granted: boolean } | { ok: false; error: string };

/** Chrome's own permission prompt for one origin. It MUST be called synchronously from the popup's
 * click handler — Chrome requires a user gesture, and the service worker has none, which is why
 * background.ts/sites.ts never request permissions themselves (design §4). A rejection is reported
 * rather than thrown, so the caller can show it and send nothing. */
async function requestOrigin(origin: string): Promise<PermissionOutcome> {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return { ok: true, granted: false };
  try {
    return { ok: true, granted: await chrome.permissions.request({ origins: [`${origin}/*`] }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

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

export async function initPopup(doc: Document, deps: { send: typeof send; activeTabUrl?: string }): Promise<void> {
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
  const siteOriginEl = $(doc, 'site-origin');
  const siteToggleEl = $<HTMLButtonElement>(doc, 'site-toggle');
  const siteStatusEl = $(doc, 'site-status');
  const genericSitesEl = $(doc, 'generic-sites');
  const statsEl = $(doc, 'stats');
  const pageSeenEl = $(doc, 'page-seen');
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
    genericSites = s.genericSites;
    renderThisSite();
  }

  // --- This site (design addendum §4): opting any origin into the generic adapter, one click ---

  /** Every enabled generic origin, each with a `remove` link (the same effect as Disable below). */
  function renderGenericSites(): void {
    genericSitesEl.textContent = '';
    for (const origin of genericSites) {
      const li = doc.createElement('li');
      li.textContent = `${origin} `;
      const remove = doc.createElement('a');
      remove.href = '#';
      remove.textContent = 'remove';
      remove.addEventListener('click', (ev) => {
        ev.preventDefault();
        void applySiteChange('disableSite', origin);
      });
      li.appendChild(remove);
      genericSitesEl.appendChild(li);
    }
  }

  function defaultSiteStatus(enabled: boolean): string {
    if (siteBuiltIn) return 'built in'; // shipped in the manifest's static content_scripts; see the Sites checkboxes
    if (siteOrigin === undefined) return 'not a web page';
    return enabled ? 'enabled' : '';
  }

  /** Renders the whole section from the active tab plus the current `genericSites`. `status` overrides
   * the state's own status line with what a click just did. */
  function renderThisSite(status?: string, isError = false): void {
    const enabled = siteOrigin !== undefined && genericSites.includes(siteOrigin);
    siteOriginEl.textContent = siteOrigin ?? '';
    siteToggleEl.hidden = siteOrigin === undefined || siteBuiltIn;
    siteToggleEl.textContent = enabled ? 'Disable on this site' : 'Enable on this site';
    siteStatusEl.textContent = status ?? defaultSiteStatus(enabled);
    siteStatusEl.classList.toggle('error', isError);
    renderGenericSites();
  }

  /** Sends enableSite/disableSite and re-renders from the reply's `genericSites`, which is the full
   * resulting list — the popup never derives it locally from the request it just sent. */
  async function applySiteChange(type: 'enableSite' | 'disableSite', origin: string, status?: string): Promise<void> {
    const res = await send({ type, origin });
    if (!res.ok) {
      renderThisSite(res.error, true);
      return;
    }
    genericSites = res.genericSites;
    renderThisSite(status);
  }

  function fillStats(stats: DuoStats, exampleCount: number): void {
    statsEl.textContent =
      `judged ${stats.judged} · folded ${stats.folded} · kept ${stats.kept} · ` +
      `errors ${stats.errors} · p50 ${Math.round(stats.p50LatencyMs)}ms · ~$${stats.estimatedUsd.toFixed(4)}`;
    examplesEl.textContent = `${exampleCount} corrections`;
  }

  /** Spec §8's "0 posts seen on this page": the content script reports its count per tab, so an
   * adapter whose selectors have gone stale shows up here as a visible zero instead of silence. */
  function fillPageSeen(reports: PageSeenReport[], tabId: number | undefined): void {
    const report = tabId === undefined ? undefined : reports.find((r) => r.tabId === tabId);
    // `generic` is the adapter's name, not a site's: "6 posts seen on generic" reads like a place the
    // user has never heard of, where every other platform id is one they recognise.
    const where = report?.platform === 'generic' ? 'this site' : report?.platform;
    pageSeenEl.textContent = !report ? NO_PAGE_REPORT : report.seen === 0 ? ZERO_SEEN : `${report.seen} posts seen on ${where}`;
    pageSeenEl.classList.toggle('error', report?.seen === 0);
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

  // Resolved once below, before the first getState: the active tab cannot change while the popup
  // that opened over it is open. `siteOrigin` is that tab's http(s) origin (undefined on a
  // chrome://, about: or extension page) and `siteBuiltIn` whether it is one of the three shipped
  // sites; `genericSites` is the last list the background reported.
  let tabId: number | undefined;
  let siteOrigin: string | undefined;
  let siteBuiltIn = false;
  let genericSites: string[] = [];

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
    fillPageSeen(res.pageSeen, tabId);
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

  // Design §4's one-click opt-in: Chrome's permission prompt runs FIRST and inside this click handler
  // (it needs the user gesture, which the service worker has none of), and only a granted permission
  // reaches the background, which then registers the origin's dynamic content script.
  siteToggleEl.addEventListener(
    'click',
    guardClick([siteToggleEl], async () => {
      const origin = siteOrigin;
      if (origin === undefined) return;
      if (genericSites.includes(origin)) {
        // Disabling unregisters the content script, but a tab that already loaded it keeps running it
        // until it is reloaded — same shape of promise as the enable line, in reverse (spec §5).
        await applySiteChange('disableSite', origin, 'disabled — reload the tab to stop judging');
        return;
      }
      const asked = await requestOrigin(origin);
      if (!asked.ok) {
        // Nothing was granted and nothing was sent: say what failed rather than blame the user for a
        // decline they never made.
        renderThisSite(`permission request failed: ${asked.error}`, true);
        return;
      }
      if (!asked.granted) {
        renderThisSite('permission declined');
        return;
      }
      await applySiteChange('enableSite', origin, 'enabled — reload the tab to start judging');
    }),
  );

  arbiterEl.addEventListener('change', () => patchSettings({ arbiter: arbiterEl.checked }));
  siteXEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));
  siteRedditEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));
  siteHnEl.addEventListener('change', () => patchSettings({ enabledSites: currentSites() }));

  const tab = await activeTab();
  tabId = tab?.id;
  const parsedUrl = parseHttpUrl(deps.activeTabUrl ?? tab?.url ?? '');
  siteOrigin = parsedUrl?.origin;
  siteBuiltIn = parsedUrl !== undefined && isBuiltInHost(parsedUrl.hostname);

  const initial = await send({ type: 'getState' });
  if (initial.ok && initial.type === 'getState') {
    fillSettings(initial.settings);
    fillStats(initial.stats, initial.exampleCount);
    fillPageSeen(initial.pageSeen, tabId);
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
  // `?jd-tab=<url>` is a TEST HOOK for the e2e, honoured only when popup.html is opened as an ordinary
  // tab — the action popup never has a query string — because `chrome.tabs.query({active:true})` would
  // otherwise answer with the popup's own tab there. Nothing in the shipped UI ever sets it.
  const activeTabUrl = new URLSearchParams(location.search).get('jd-tab') ?? undefined;
  void initPopup(document, { send, activeTabUrl }).catch((err: unknown) => console.error('jev-duo popup: init failed', err));
}
