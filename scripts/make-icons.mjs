// Renders the extension icons (16, 48, 128 px) from an inline SVG using
// Playwright's Chromium and writes them to src/extension/icons/.
//
// Design: rounded square, near-black background (#0B0B0F); a lightning bolt
// split down the vertical centre line: left half electric blue (#4CC9F0),
// right half amber (#F4A261). Two halves, two brains.
//
// Run with `pnpm build:icons`. The PNGs are committed; rerun only when the
// design changes.

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'extension', 'icons');
const SIZES = [16, 48, 128];

const BACKGROUND = '#0B0B0F';
const LEFT = '#4CC9F0';
const RIGHT = '#F4A261';
const BOLT = '76,10 38,70 60,70 52,118 92,54 70,54 82,10';

function svg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128" style="display:block">
  <defs>
    <clipPath id="left"><rect x="0" y="0" width="64" height="128"/></clipPath>
    <clipPath id="right"><rect x="64" y="0" width="64" height="128"/></clipPath>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="28" ry="28" fill="${BACKGROUND}"/>
  <polygon points="${BOLT}" fill="${LEFT}" clip-path="url(#left)"/>
  <polygon points="${BOLT}" fill="${RIGHT}" clip-path="url(#right)"/>
</svg>`;
}

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent">${svg(size)}</body></html>`,
    );
    const file = path.join(outDir, `icon${size}.png`);
    await page.screenshot({
      path: file,
      type: 'png',
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    console.log(`icons: wrote ${path.relative(root, file)} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
