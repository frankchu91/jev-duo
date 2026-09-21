import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = path.dirname(fileURLToPath(import.meta.url));

// Load the repo's .env so `LIVE=1 pnpm test:e2e:live` picks up TYPESAFE_API_KEY / OPENROUTER_API_KEY
// the same way the CLI does. Missing file (or a Node without loadEnvFile): the live tests just skip.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env — fine, the @live-jev tests skip themselves
}

export default defineConfig({
  testDir: 'tests/e2e',
  // globalSetup builds dist/ if it is missing and serves tests/e2e/fixtures on 127.0.0.1:4173 for
  // the whole run; the function it returns is the teardown that closes the server again.
  globalSetup: './tests/e2e/server.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
