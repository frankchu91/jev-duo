import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Worker } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const extensionDir = path.join(root, 'dist', 'extension');

test.describe.configure({ mode: 'serial' });

let profileDir: string, context: BrowserContext, worker: Worker;
let headless = true;

// "channel: chromium" opts into the new headless mode, needed for
// --load-extension to take effect with headless: true.
async function launch(isHeadless: boolean): Promise<BrowserContext> {
  profileDir = await mkdtemp(path.join(tmpdir(), 'jev-duo-e2e-'));
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: isHeadless,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
}

async function getServiceWorker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}

test.beforeAll(async () => {
  if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
    execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  }
  context = await launch(true);
  try {
    worker = await getServiceWorker();
  } catch {
    // Headless extension loading is occasionally flaky; retry headed once.
    headless = false;
    await context.close();
    await rm(profileDir, { recursive: true, force: true });
    context = await launch(false);
    worker = await getServiceWorker();
  }
});

test.afterAll(async () => {
  await context?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
});

test('background service worker starts', () => {
  console.log(`extension loaded ${headless ? 'headless' : 'headed (fallback)'}: ${worker.url()}`);
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
});

test('popup renders', async () => {
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('h1')).toHaveText('jev-duo');
  await expect(page.locator('#v')).toHaveText('v0.1.0');
});
