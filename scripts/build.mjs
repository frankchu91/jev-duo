// Builds the CLI and the Chrome extension with esbuild.
//
//   dist/cli/index.js          node ESM bundle, executable (`jev-duo` bin)
//   dist/extension/*           unpacked Manifest V3 extension
//
// Run with `pnpm build`. Icons must exist first (`pnpm build:icons`).

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const extSrc = path.join(src, 'extension');
const dist = path.join(root, 'dist');
const extDist = path.join(dist, 'extension');

const rel = (p) => path.relative(root, p);
const outputs = [];

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'cli'), { recursive: true });
await mkdir(path.join(extDist, 'icons'), { recursive: true });

// (a) CLI: single executable ESM bundle for node >= 20.
const cliOut = path.join(dist, 'cli', 'index.js');
await build({
  entryPoints: [path.join(src, 'cli', 'index.ts')],
  outfile: cliOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
await chmod(cliOut, 0o755);
outputs.push(rel(cliOut));

// (b) Extension scripts. The service worker is declared `type: module` in the
// manifest, so it may stay ESM; content script and popup must be IIFEs. These
// are minified (the CLI is not: it stays readable for `node dist/cli/index.js`
// stack traces) because the service worker bundle carries the Anthropic SDK and
// Chrome parses the whole thing on every wake-up.
const extEntries = [
  { entry: 'background.ts', out: 'background.js', format: 'esm' },
  { entry: 'content.ts', out: 'content.js', format: 'iife' },
  { entry: path.join('popup', 'popup.ts'), out: 'popup.js', format: 'iife' },
  // The injected reader has to HAND ITS RESULT BACK to the popup: chrome.scripting.executeScript
  // resolves with the completion value of the injected file's last statement, and a bundle's last
  // statement is the IIFE call, whose value is undefined. esbuild's `footer.js` is inserted verbatim
  // after everything else (not minified, not part of the bundle's scope), so one more expression
  // statement reading the global the bundle just assigned is exactly what is needed. Verified against
  // esbuild 0.28.2, whose BuildOptions declares `footer?: { [type: string]: string }`.
  { entry: 'read-page.ts', out: 'read-page.js', format: 'iife', footer: { js: 'globalThis.__jevDuoReadResult;' } },
  // The reader page is an ordinary extension page, so its bundle may stay ESM — which matters,
  // because it carries pdf.js.
  { entry: path.join('reader', 'reader.ts'), out: 'reader.js', format: 'esm' },
];
for (const { entry, out, format, footer } of extEntries) {
  const outfile = path.join(extDist, out);
  await build({
    entryPoints: [path.join(extSrc, entry)],
    outfile,
    bundle: true,
    platform: 'browser',
    format,
    target: 'chrome120',
    minify: true,
    ...(footer ? { footer } : {}),
    logLevel: 'warning',
  });
  outputs.push(rel(outfile));
}

// (c) Static assets, flattened into dist/extension/ (icons keep their folder,
// matching the paths declared in manifest.json).
for (const file of [
  'manifest.json',
  path.join('popup', 'popup.html'),
  path.join('popup', 'popup.css'),
  path.join('reader', 'reader.html'),
  path.join('reader', 'reader.css'),
  'styles.css',
]) {
  const dest = path.join(extDist, path.basename(file));
  await cp(path.join(extSrc, file), dest);
  outputs.push(rel(dest));
}

// pdf.js runs its parser in a worker, which must be a file of its own: it is loaded from the
// extension's own origin (reader.ts points GlobalWorkerOptions.workerSrc at chrome.runtime.getURL),
// which the default extension CSP allows and which needs no web_accessible_resources entry.
const workerSrc = path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
if (!existsSync(workerSrc)) {
  console.error('build: no pdf.worker.min.mjs in node_modules/pdfjs-dist/build — run `pnpm install` first');
  process.exit(1);
}
const workerDest = path.join(extDist, 'pdf.worker.mjs');
await cp(workerSrc, workerDest);
outputs.push(rel(workerDest));

const iconsDir = path.join(extSrc, 'icons');
const icons = (await readdir(iconsDir).catch(() => [])).filter((f) => f.endsWith('.png')).sort();
if (icons.length === 0) {
  console.error('build: no icons in src/extension/icons — run `pnpm build:icons` first');
  process.exit(1);
}
for (const icon of icons) {
  const dest = path.join(extDist, 'icons', icon);
  await cp(path.join(iconsDir, icon), dest);
  outputs.push(rel(dest));
}

console.log(`build: ${outputs.length} files -> ${outputs.join(', ')}`);
