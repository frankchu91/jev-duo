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

// One stamp per build, handed to every EXTENSION bundle and to none of the CLI's: the popup compares
// its own against the service worker's and refuses to read when they differ, which is what turns
// "65 errors" into "reload the extension" before anything is clicked (design addendum §3.3).
const buildId = new Date().toISOString();

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
    define: { __JD_BUILD__: JSON.stringify(buildId) },
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

// pdf.js keeps three things out of its bundle and fetches them at runtime: the standard 14 font
// programs, the CJK cmaps, and the wasm decoders for JPX/JBIG2 images. They are copied to the
// extension's own origin (about 4 MB together, so the zip grows by roughly that), where reader.ts
// points getDocument at them with chrome.runtime.getURL — which the default extension CSP allows and
// which needs no web_accessible_resources entry, exactly like the worker above. Same guard, too: a
// missing folder is a one-line build failure rather than a PDF that renders blank at runtime.
//
// The `.wasm` files in that folder need `'wasm-unsafe-eval'` in the extension's content security
// policy (manifest.json, `content_security_policy.extension_pages`): Manifest V3's default policy
// refuses to compile WebAssembly, and pdf.js's worker tries to whenever a PDF carries an ICC colour
// profile or a JPX/JBIG2 image — Chrome then records the refusal on the extension's Errors page,
// which is how the field test found it. With the policy in place the decoders load; without it
// pdf.js would fall back to the slower JavaScript decoders shipped in the same folder
// (jbig2_nowasm_fallback.js, openjpeg_nowasm_fallback.js) and colour profiles would be skipped.
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
  const from = path.join(root, 'node_modules', 'pdfjs-dist', folder);
  if (!existsSync(from)) {
    console.error(`build: no ${folder} in node_modules/pdfjs-dist — run \`pnpm install\` first`);
    process.exit(1);
  }
  const dest = path.join(extDist, folder);
  await cp(from, dest, { recursive: true });
  outputs.push(rel(dest));
}

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
