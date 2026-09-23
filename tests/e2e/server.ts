// Static file server for the e2e fixture pages (tests/e2e/fixtures) plus the Playwright globalSetup
// (this file's default export) that starts it: the server lives in the runner process for the whole
// run and is closed again by the teardown function globalSetup returns.
//
// The extension's shipped manifest only matches the four real sites, so helpers.ts patches a COPY of
// the built extension to also match this origin — see helpers.ts's `patchExtension`.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PORT = 4173;
export const FIXTURE_HOST = '127.0.0.1';
export const FIXTURE_ORIGIN = `http://${FIXTURE_HOST}:${FIXTURE_PORT}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const ROOT = path.resolve(HERE, '../..');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** Resolves a request path inside FIXTURES_DIR, or `undefined` for anything that escapes it. */
function resolveFixture(urlPath: string): string | undefined {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const full = path.join(FIXTURES_DIR, rel);
  return full.startsWith(FIXTURES_DIR + path.sep) ? full : undefined;
}

export function startFixtureServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const file = resolveFixture(req.url ?? '/');
    void (async () => {
      if (!file || !(await stat(file).catch(() => undefined))?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FIXTURE_PORT, FIXTURE_HOST, () => {
      resolve({
        origin: FIXTURE_ORIGIN,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // close() alone waits for idle keep-alive sockets, which a still-open browser would hold
            // open forever — drop them so teardown can never hang the run.
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Playwright globalSetup: makes sure `dist/` exists (the suite drives the REAL built extension and
 * the REAL built CLI, never the sources) and starts the fixture server. The returned function is run
 * by Playwright as the global teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(path.join(ROOT, 'dist', 'extension', 'manifest.json')) || !existsSync(path.join(ROOT, 'dist', 'cli', 'index.js'))) {
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
  }
  const server = await startFixtureServer();
  return () => server.close();
}
