// Zips the built extension (dist/extension) into jev-duo-extension.zip at the
// repo root, with manifest.json at the zip root as the Chrome Web Store expects.
// Uses the `zip` CLI (present on macOS and most Linux images).
//
// Run with `pnpm package:ext` after `pnpm build`.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDist = path.join(root, 'dist', 'extension');
const zipPath = path.join(root, 'jev-duo-extension.zip');

if (!existsSync(extDist)) {
  console.error('package:ext: dist/extension does not exist — run `pnpm build` first');
  process.exit(1);
}
if (!existsSync(path.join(extDist, 'manifest.json'))) {
  console.error('package:ext: dist/extension has no manifest.json — run `pnpm build` first');
  process.exit(1);
}

rmSync(zipPath, { force: true });

try {
  // -r recurse, -X drop extra (macOS) file attributes, -q quiet.
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '*.DS_Store'], {
    cwd: extDist,
    stdio: 'inherit',
  });
} catch (err) {
  console.error(`package:ext: zip failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const bytes = statSync(zipPath).size;
console.log(`package:ext: wrote ${path.relative(root, zipPath)} (${(bytes / 1024).toFixed(1)} KiB)`);
