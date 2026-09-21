// Shared plumbing for the extension e2e specs: launching Chromium with the REAL built extension,
// driving the background service worker, and waiting for the content script's decorations.
//
// Two things need explaining:
//
// (a) The shipped manifest only matches x/twitter/reddit/hn, so the content script would never run on
//     the fixture origin. `patchExtension` copies `dist/extension` to a temp dir and widens that
//     COPY's `matches`/`host_permissions` — the shipped manifest is never touched. (`pickAdapter`
//     honours `?jd-platform=x|reddit|hn`, so one localhost origin can stand in for all three sites.)
//
// (b) `chrome.runtime.sendMessage` never delivers to the sender's own context, so the background
//     cannot be driven with messages from inside its own service worker. background.ts exposes the
//     created background as `globalThis.__jevDuo` (a test hook) and `callBackground` below drives
//     that — the same `handle(req)` the real onMessage listener calls.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { chromium, expect } from '@playwright/test';
import type { QuestionPack } from '../../src/core/types';
import type { Request, Response, Settings } from '../../src/extension/messages';
import { FIXTURE_ORIGIN } from './server';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_DIR = path.join(ROOT, 'dist', 'extension');
const SERVICE_WORKER_TIMEOUT_MS = 10_000;

// `http://127.0.0.1:4173/*`. Chromium honours the port here (verified: the same manifest with
// :9999 injects nothing on :4173), so this only ever widens the extension to the fixture server.
const FIXTURE_MATCH = `${FIXTURE_ORIGIN}/*`;

/** Any post the content script has finished judging carries one of these: a fold bar, a dim/badge/
 * kept tag, or (for a plain keep) the hover "hide this" button. Counting them is how the specs wait
 * for judgments without sleeping — `[data-jd="pending"]` is REMOVED once a verdict lands. */
export const JUDGED_SELECTOR = '.jd-bar, .jd-tag, .jd-hide';

export interface LaunchedExtension {
  context: BrowserContext;
  extensionId: string;
  sw: Worker;
  /** True when the extension loaded headless; false if it needed the headed fallback. */
  headless: boolean;
  close(): Promise<void>;
}

/** Copy of `dist/extension` whose manifest also matches the fixture origin. Returns the temp dir. */
async function patchExtension(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jev-duo-ext-'));
  await cp(EXTENSION_DIR, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
    content_scripts: Array<{ matches: string[] }>;
  };
  manifest.host_permissions.push(FIXTURE_MATCH);
  manifest.content_scripts[0].matches.push(FIXTURE_MATCH);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

// `channel: 'chromium'` opts into the new headless mode, which is what makes --load-extension take
// effect with `headless: true` (the old headless shell ignores extensions entirely).
function launch(extensionDir: string, profileDir: string, headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
}

async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS }));
}

/** Launches Chromium with the (patched) built extension in a throwaway profile. Retries headed once
 * if the headless launch produces no service worker, and cleans up both temp dirs on `close()`. */
export async function launchWithExtension(): Promise<LaunchedExtension> {
  const extensionDir = await patchExtension();
  const profileDirs: string[] = [];

  async function attempt(headless: boolean): Promise<{ context: BrowserContext; sw: Worker }> {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'jev-duo-profile-'));
    profileDirs.push(profileDir);
    const context = await launch(extensionDir, profileDir, headless);
    try {
      return { context, sw: await serviceWorkerOf(context) };
    } catch (err) {
      await context.close();
      throw err;
    }
  }

  const cleanupTemp = (): Promise<unknown> =>
    Promise.all([extensionDir, ...profileDirs].map((d) => rm(d, { recursive: true, force: true })));

  let headless = true;
  let started: { context: BrowserContext; sw: Worker };
  try {
    started = await attempt(true);
  } catch (headlessErr) {
    // Headless extension loading is occasionally flaky locally, so one headed retry is worth it
    // there. On CI there is no display to be headed on: the retry can only fail slowly (or hang),
    // so the headless failure is reported as-is instead.
    if (process.env.CI) {
      await cleanupTemp();
      throw headlessErr;
    }
    headless = false;
    try {
      started = await attempt(false);
    } catch (err) {
      await cleanupTemp(); // neither launch worked: don't leave the temp dirs behind
      throw err;
    }
  }

  const { context, sw } = started;
  return {
    context,
    sw,
    headless,
    extensionId: new URL(sw.url()).hostname,
    async close(): Promise<void> {
      await context.close();
      await cleanupTemp();
    },
  };
}

/** Drives the background through its test hook. Always resolves against the CURRENT service worker,
 * since Chrome may have stopped and restarted the one captured at launch. */
export async function callBackground(ext: LaunchedExtension, req: Request): Promise<Response> {
  const sw = ext.context.serviceWorkers()[0] ?? ext.sw;
  return (await sw.evaluate(async (r: Request) => {
    const hook = (globalThis as unknown as { __jevDuo?: { handle(req: Request): Promise<Response> } }).__jevDuo;
    if (!hook) throw new Error('jev-duo e2e: background test hook (globalThis.__jevDuo) is missing');
    return hook.handle(r);
  }, req)) as Response;
}

function assertOk(res: Response, what: string): Extract<Response, { ok: true }> {
  if (!res.ok) throw new Error(`jev-duo e2e: ${what} failed: ${res.error}`);
  return res;
}

/** Applies a settings patch (provider mode, mock fixtures, keys, ...) and rebuilds the agent. */
export async function seedSettings(ext: LaunchedExtension, patch: Partial<Settings>): Promise<void> {
  assertOk(await callBackground(ext, { type: 'setSettings', patch }), 'setSettings');
}

/** Compiles `intent` in the background (mock LLM unless the seeded settings say otherwise) and
 * returns the pack it persisted — the specs read the real rule ids off this rather than assuming. */
export async function compileIntent(ext: LaunchedExtension, intent: string): Promise<QuestionPack> {
  const res = assertOk(await callBackground(ext, { type: 'compile', intent }), 'compile');
  if (res.type !== 'compile') throw new Error(`jev-duo e2e: unexpected compile response ${res.type}`);
  return res.pack;
}

export type BackgroundState = Extract<Response, { type: 'getState' }>;

export async function getState(ext: LaunchedExtension): Promise<BackgroundState> {
  const res = assertOk(await callBackground(ext, { type: 'getState' }), 'getState');
  if (res.type !== 'getState') throw new Error(`jev-duo e2e: unexpected getState response ${res.type}`);
  return res;
}

export async function resetStats(ext: LaunchedExtension): Promise<void> {
  assertOk(await callBackground(ext, { type: 'resetStats' }), 'resetStats');
}

/** `http://127.0.0.1:4173/x.html?jd-platform=x` — the query param makes `pickAdapter` choose the
 * site adapter that the fixture's markup was copied from. */
export function fixtureUrl(site: 'x' | 'reddit' | 'hn'): string {
  return `${FIXTURE_ORIGIN}/${site}.html?jd-platform=${site}`;
}

export const judged = (page: Page): Locator => page.locator(JUDGED_SELECTOR);

/** Waits until the content script has decorated `count` posts and nothing is pending any more. */
export async function waitForJudged(page: Page, count: number, timeout = 15_000): Promise<void> {
  await expect(judged(page)).toHaveCount(count, { timeout });
  await expect(page.locator('[data-jd="pending"]')).toHaveCount(0, { timeout });
}

/** Waits until at least `min` posts have been judged (live pages have no fixed post count). */
export async function waitForAtLeastJudged(page: Page, min: number, timeout = 15_000): Promise<number> {
  await expect
    .poll(() => judged(page).count(), { timeout, message: `expected at least ${min} judged posts` })
    .toBeGreaterThanOrEqual(min);
  return judged(page).count();
}
