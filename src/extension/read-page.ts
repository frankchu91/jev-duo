// Injected on demand by the popup (chrome.scripting.executeScript with files: ['read-page.js']) under
// activeTab — no host permission, no manifest change, nothing running until the user asks (§2). The
// same injection stops the reader the second time it runs, which is what makes Read this page a
// toggle rather than a switch that can only be turned on.
//
// Its COMPLETION VALUE is what executeScript hands back to the popup: scripts/build.mjs appends
// `globalThis.__jevDuoReadResult;` after the bundle (esbuild `footer.js`), so everything here assigns
// that global SYNCHRONOUSLY and nothing at the top level awaits. Judging continues afterwards.

import { send } from './messages';
import { articleCandidates, extractArticle } from './reading/article';
import { mountReader } from './reading/reader-ui';
import { runReading } from './reading/run';

export type ReadResult =
  | { state: 'started'; passages: number }
  | { state: 'stopped' }
  | { state: 'no-article'; passages: number };

interface ReaderGlobals {
  __jevDuoReader?: { destroy(): void };
  __jevDuoReadResult?: ReadResult;
}

const globals = globalThis as unknown as ReaderGlobals;

function run(): ReadResult {
  const existing = globals.__jevDuoReader;
  if (existing) {
    // Cleared before destroy() so the onClose below cannot resurrect a stale handle; destroy() itself
    // removes every class, tag and node the reader added.
    delete globals.__jevDuoReader;
    existing.destroy();
    return { state: 'stopped' };
  }

  const article = extractArticle(document);
  if (!article) {
    // Nothing is mounted: the popup says how many paragraphs were even considered, which is the
    // difference between "not an article" and "this page has no text yet".
    return { state: 'no-article', passages: articleCandidates(document).length };
  }

  const handle = mountReader(document, {
    passages: article.passages,
    // The background owns Settings.focus and a content script may not ask for it (getState is refused
    // to tabs), so the panel starts without one and runReading fills it in from the first reply.
    focus: '',
    onClose: () => {
      delete globals.__jevDuoReader;
    },
  });
  globals.__jevDuoReader = handle;

  void runReading({ handle, ctx: article.ctx, passages: article.passages, send }).catch((err: unknown) => {
    console.error('jev-duo reader: judging failed', err);
  });

  return { state: 'started', passages: article.passages.length };
}

globals.__jevDuoReadResult = run();
