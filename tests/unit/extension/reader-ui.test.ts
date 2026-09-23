// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DocContext, Passage, ReadingVerdict } from '../../../src/core/reading';
import type { ArticlePassage } from '../../../src/extension/reading/article';
import { lastErrorLine, mountReader, READER_CSS, STALE_BACKGROUND_HINT } from '../../../src/extension/reading/reader-ui';
import { runReading } from '../../../src/extension/reading/run';
import type { Request, Response, send } from '../../../src/extension/messages';

/** A document with `n` paragraphs, returned as the ArticlePassage list a reader would mount. */
function docWith(n: number, opts: { pages?: boolean } = {}): { doc: Document; passages: ArticlePassage[] } {
  const doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
  const passages: ArticlePassage[] = [];
  for (let i = 0; i < n; i++) {
    const el = doc.createElement('p');
    el.id = `p${i}`;
    el.textContent = `Passage number ${i} with quite a lot of text in it so the snippet is truncated somewhere sensible.`;
    doc.body.appendChild(el);
    passages.push({ id: `rd:${i}`, index: i, text: el.textContent ?? '', el, ...(opts.pages ? { page: i + 1 } : {}) });
  }
  return { doc, passages };
}

const verdict = (id: string, v: ReadingVerdict['verdict'], extra: Partial<ReadingVerdict> = {}): ReadingVerdict => ({
  id,
  verdict: v,
  p: 0.82,
  core: 0.82,
  ...extra,
});

const panelOf = (doc: Document): ShadowRoot => {
  const root = doc.getElementById('jd-reader')?.shadowRoot;
  if (!root) throw new Error('test: no reader panel');
  return root;
};

describe('mountReader decorations', () => {
  it('highlights, tags, dims and leaves plain passages alone', () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:0', 'highlight', { kind: 'method' }));
    handle.apply(verdict('rd:1', 'dim'));
    handle.apply(verdict('rd:2', 'plain'));

    expect(passages[0].el.classList.contains('jd-hl')).toBe(true);
    expect(passages[0].el.querySelector('.jd-rtag')?.textContent).toBe('method · 82%');
    expect(passages[1].el.classList.contains('jd-dim')).toBe(true);
    expect(passages[2].el.className).toBe('');
    expect(passages[2].el.querySelector('.jd-rtag')).toBeNull();
  });

  it('tags a highlight with no kind as the percentage alone', () => {
    const { doc, passages } = docWith(1);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:0', 'highlight', { p: 0.9 }));
    expect(passages[0].el.querySelector('.jd-rtag')?.textContent).toBe('90%');
  });

  it('injects READER_CSS once, under a stable id', () => {
    const { doc, passages } = docWith(1);
    mountReader(doc, { passages, focus: '', onClose: () => {} });
    const styles = doc.querySelectorAll('#jd-reader-style');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(READER_CSS);
    expect(READER_CSS).toContain('opacity: .35 !important');
  });

  it('ignores a verdict for a passage it does not have', () => {
    const { doc, passages } = docWith(1);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    expect(() => handle.apply(verdict('rd:nope', 'highlight'))).not.toThrow();
    expect(panelOf(doc).querySelectorAll('li')).toHaveLength(0);
  });
});

describe('mountReader panel', () => {
  it('lists only the highlights, in document order however the verdicts arrive', () => {
    const { doc, passages } = docWith(4);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:3', 'highlight', { kind: 'result' }));
    handle.apply(verdict('rd:1', 'highlight', { kind: 'claim' }));
    handle.apply(verdict('rd:2', 'dim'));
    handle.apply(verdict('rd:0', 'highlight', { kind: 'method' }));

    const items = [...panelOf(doc).querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items.map((t) => t.split(' · ')[0])).toEqual(['method', 'claim', 'result']);
    expect(items[0]).toBe('method · Passage number 0 with quite a lot of text in it so the snippet is trunc…');
  });

  it('prefixes a page number when the passage has one', () => {
    const { doc, passages } = docWith(2, { pages: true });
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:1', 'highlight', { kind: 'claim' }));
    expect(panelOf(doc).querySelector('li')?.textContent?.startsWith('p. 2 · claim · ')).toBe(true);
  });

  it('shows the focus line only when there is a focus', () => {
    const { doc, passages } = docWith(1);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('');

    handle.setFocus('why does it work');
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('focus: why does it work');
  });

  it('counts progress, then replaces it with the summary line', () => {
    const { doc, passages } = docWith(12);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.setProgress(6, 12);
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('6 of 12 judged');

    handle.finish({ ms: 3450, usageTokens: 120_000, errors: 0 });
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('12 passages · 3.5 s · ~$0.0050');
  });

  it('appends the error count to the summary only when there were errors', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 3 });
    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('2 passages · 1.0 s · ~$0.0000 · 3 errors');
  });

  it('Show all removes every dim and relabels itself; Dim again puts them back', () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    handle.apply(verdict('rd:0', 'dim'));
    handle.apply(verdict('rd:1', 'dim'));

    const button = [...panelOf(doc).querySelectorAll('button')].find((b) => b.textContent === 'Show all');
    button?.click();
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(0);
    expect(button?.textContent).toBe('Dim again');

    // A verdict that lands while everything is shown must not re-dim behind the user's back.
    handle.apply(verdict('rd:2', 'dim'));
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(0);

    button?.click();
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(3);
    expect(button?.textContent).toBe('Show all');
  });

  it('scrolls and flashes the passage a list item points at', () => {
    vi.useFakeTimers();
    const { doc, passages } = docWith(1);
    const scrollIntoView = vi.fn();
    Object.assign(passages[0].el, { scrollIntoView }); // jsdom has no scrollIntoView of its own
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:0', 'highlight'));

    // `doc` is a detached DOMParser document (`defaultView` is null per spec, verified against jsdom),
    // so the click is constructed from the global MouseEvent rather than the document's own window.
    panelOf(doc).querySelector('li')?.dispatchEvent(new MouseEvent('click'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(passages[0].el.classList.contains('jd-flash')).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(passages[0].el.classList.contains('jd-flash')).toBe(false);
    vi.useRealTimers();
  });
});

describe('the panel says why it failed (§3.2)', () => {
  const errorLineOf = (doc: Document): string | null => panelOf(doc).querySelector('p.error')?.textContent ?? null;

  it('prints the last error under the summary', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({
      ms: 1000,
      usageTokens: 0,
      errors: 2,
      lastError: 'invalid api key',
    });

    expect(panelOf(doc).querySelector('.progress')?.textContent).toBe('2 passages · 1.0 s · ~$0.0000 · 2 errors');
    expect(errorLineOf(doc)).toBe('last error: invalid api key');
  });

  it('turns a stale service worker into the reload hint instead', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({
      ms: 1000,
      usageTokens: 0,
      errors: 2,
      lastError: 'unknown request type: readPassages',
    });

    expect(errorLineOf(doc)).toBe(STALE_BACKGROUND_HINT);
    expect(STALE_BACKGROUND_HINT).toBe('the extension was updated — reload it at chrome://extensions (↻) and read again');
  });

  it('admits when the errors carried no message at all', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 2 });

    expect(errorLineOf(doc)).toBe('errors without a message');
  });

  it('adds no second line when nothing failed', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 0 });

    expect(errorLineOf(doc)).toBe('');
  });

  // --- Review fix round 2, minor C: an Error with an empty message must not print `last error: ` ---

  it('treats an empty or blank message as no message at all', () => {
    const { doc, passages } = docWith(2);
    mountReader(doc, { passages, focus: '', onClose: () => {} }).finish({ ms: 1000, usageTokens: 0, errors: 2, lastError: '' });

    expect(errorLineOf(doc)).toBe('errors without a message');
    // The judge stores `undefined` for these, but the reply crosses a message port from a background
    // that may be an older build, so the panel refuses them on its own too.
    expect(lastErrorLine('')).toBe('errors without a message');
    expect(lastErrorLine('   ')).toBe('errors without a message');
  });

  it('lastErrorLine is the whole decision, and is pure', () => {
    expect(lastErrorLine(undefined)).toBe('errors without a message');
    expect(lastErrorLine('HTTP 502')).toBe('last error: HTTP 502');
    expect(lastErrorLine('unknown request type: readPassages')).toBe(STALE_BACKGROUND_HINT);
    expect(lastErrorLine('unknown request type')).toBe(STALE_BACKGROUND_HINT);
    // Not a prefix match: a message that merely mentions it is still printed verbatim.
    expect(lastErrorLine('the background replied unknown request type')).toBe('last error: the background replied unknown request type');
  });
});

describe('mountReader lifecycle', () => {
  it('destroy restores the DOM, removes the style and calls onClose', () => {
    const { doc, passages } = docWith(2);
    const onClose = vi.fn();
    const handle = mountReader(doc, { passages, focus: '', onClose });
    handle.apply(verdict('rd:0', 'highlight', { kind: 'claim' }));
    handle.apply(verdict('rd:1', 'dim'));

    handle.destroy();

    expect(doc.getElementById('jd-reader')).toBeNull();
    expect(doc.getElementById('jd-reader-style')).toBeNull();
    expect(doc.querySelectorAll('.jd-hl, .jd-dim, .jd-rtag')).toHaveLength(0);
    expect(doc.body.innerHTML).toContain('Passage number 0');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('both Close buttons destroy the panel', () => {
    for (const label of ['×', 'Close']) {
      const { doc, passages } = docWith(1);
      mountReader(doc, { passages, focus: '', onClose: () => {} });
      [...panelOf(doc).querySelectorAll('button')].find((b) => b.textContent === label)?.click();
      expect(doc.getElementById('jd-reader')).toBeNull();
    }
  });

  it('a second mountReader destroys the first', () => {
    const { doc, passages } = docWith(2);
    const onClose = vi.fn();
    const first = mountReader(doc, { passages, focus: '', onClose });
    first.apply(verdict('rd:0', 'highlight'));

    mountReader(doc, { passages, focus: '', onClose: () => {} });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(doc.querySelectorAll('#jd-reader')).toHaveLength(1);
    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(0);
  });

  // --- Fix round 1: a batch still in flight when the panel closes must not keep decorating the page ---

  it('apply/setFocus/setProgress/finish are all no-ops once destroyed', () => {
    const { doc, passages } = docWith(1);
    const handle = mountReader(doc, { passages, focus: 'the question', onClose: () => {} });
    // The panel is detached by destroy(), not discarded, so its text is still readable — which is how
    // this checks that the three setters wrote NOTHING, rather than only that they did not throw.
    const panel = panelOf(doc);
    handle.setProgress(3, 9);
    handle.destroy();

    expect(handle.isDestroyed()).toBe(true);

    handle.apply(verdict('rd:0', 'highlight', { kind: 'claim' }));
    expect(passages[0].el.classList.contains('jd-hl')).toBe(false);
    expect(passages[0].el.querySelector('.jd-rtag')).toBeNull();

    handle.setFocus('something else entirely');
    handle.setProgress(1, 1);
    handle.finish({ ms: 1, usageTokens: 1, errors: 0 });

    expect(panel.querySelector('.focus')?.textContent).toBe('focus: the question');
    expect(panel.querySelector('.progress')?.textContent).toBe('3 of 9 judged');
    expect(panel.querySelectorAll('li')).toHaveLength(0);
  });

  it('destroy() is idempotent: a second call does not call onClose again', () => {
    const { doc, passages } = docWith(1);
    const onClose = vi.fn();
    const handle = mountReader(doc, { passages, focus: '', onClose });

    handle.destroy();
    handle.destroy();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(handle.isDestroyed()).toBe(true);
  });

  it('destroy() cancels a pending flash timer, so it cannot clip a later flash on the same element short', () => {
    vi.useFakeTimers();
    const { doc, passages } = docWith(1);
    const first = mountReader(doc, { passages, focus: '', onClose: () => {} });
    first.apply(verdict('rd:0', 'highlight'));
    panelOf(doc).querySelector('li')?.dispatchEvent(new MouseEvent('click')); // flash timer due at t=1200

    first.destroy(); // must cancel that timer outright, not just remove the class it would later remove

    vi.advanceTimersByTime(600); // t=600: halfway through the (cancelled) first timer's life

    const second = mountReader(doc, { passages, focus: '', onClose: () => {} });
    second.apply(verdict('rd:0', 'highlight'));
    panelOf(doc).querySelector('li')?.dispatchEvent(new MouseEvent('click')); // flash timer due at t=1800
    expect(passages[0].el.classList.contains('jd-flash')).toBe(true);

    vi.advanceTimersByTime(600); // t=1200: exactly when the FIRST timer would have fired, if not cancelled
    expect(passages[0].el.classList.contains('jd-flash')).toBe(true); // still flashing: uninterrupted

    vi.advanceTimersByTime(600); // t=1800: the second flash's own timer
    expect(passages[0].el.classList.contains('jd-flash')).toBe(false);

    vi.useRealTimers();
  });
});

// --- Final wave, IMPORTANT: §3's id is fnv1a over the passage's first 300 characters, so a document
// that repeats a paragraph verbatim hands several passages ONE id. The panel used to index them in a
// Map<string, ArticlePassage>, which keeps only the last: one paragraph collected every tag and the
// other copies stayed plain, while the list scrolled every row to that same element. ---

describe('mountReader with passages that share an id', () => {
  /** `n` identical paragraphs, which is what `passageId` collapses onto a single id. */
  function docWithDuplicates(n: number, id = 'rd:same'): { doc: Document; passages: ArticlePassage[] } {
    const doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
    const text = 'The same legal note, repeated verbatim in several places in this document.';
    const passages: ArticlePassage[] = [];
    for (let i = 0; i < n; i++) {
      const el = doc.createElement('p');
      el.id = `p${i}`;
      el.textContent = text;
      doc.body.appendChild(el);
      passages.push({ id, index: i, text, el });
    }
    return { doc, passages };
  }

  it('highlights every element sharing the id, with one tag and one list row each', () => {
    const { doc, passages } = docWithDuplicates(10);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:same', 'highlight', { kind: 'boilerplate' }));

    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(10);
    expect(doc.querySelectorAll('.jd-rtag')).toHaveLength(10);
    for (const passage of passages) expect(passage.el.querySelectorAll('.jd-rtag')).toHaveLength(1);
    expect(panelOf(doc).querySelectorAll('li')).toHaveLength(10);
  });

  it('applies an id once however many verdicts carry it — the judge returns one per passage', () => {
    const { doc, passages } = docWithDuplicates(10);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    // Exactly what runReading does with the judge's fan-out: ten verdicts, all the same id.
    for (const passage of passages) handle.apply(verdict(passage.id, 'highlight', { kind: 'boilerplate' }));

    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(10);
    expect(doc.querySelectorAll('.jd-rtag')).toHaveLength(10); // not 100
    expect(panelOf(doc).querySelectorAll('li')).toHaveLength(10);
  });

  it('dims every element sharing the id, and Show all brings all of them back', () => {
    const { doc, passages } = docWithDuplicates(4);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:same', 'dim'));
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(4);

    [...panelOf(doc).querySelectorAll('button')].find((b) => b.textContent === 'Show all')?.click();
    expect(doc.querySelectorAll('.jd-dim')).toHaveLength(0);
  });

  it('gives each row its own element to scroll to', () => {
    const { doc, passages } = docWithDuplicates(3);
    const scrolls = passages.map(() => vi.fn());
    passages.forEach((p, i) => Object.assign(p.el, { scrollIntoView: scrolls[i] }));
    mountReader(doc, { passages, focus: '', onClose: () => {} }).apply(verdict('rd:same', 'highlight'));

    const rows = [...panelOf(doc).querySelectorAll('li')];
    rows[2].dispatchEvent(new MouseEvent('click'));

    expect(scrolls.map((s) => s.mock.calls.length)).toEqual([0, 0, 1]);
    expect(passages[2].el.classList.contains('jd-flash')).toBe(true);
    expect(passages[0].el.classList.contains('jd-flash')).toBe(false);
  });

  it('keeps the list in document order when duplicates are interleaved with unique passages', () => {
    const { doc, passages } = docWithDuplicates(3);
    passages[1].id = 'rd:other';
    passages[1].el.textContent = 'A different paragraph entirely, sitting between the two copies.';
    passages[1].text = passages[1].el.textContent;
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    handle.apply(verdict('rd:other', 'highlight', { kind: 'claim' }));
    handle.apply(verdict('rd:same', 'highlight', { kind: 'boilerplate' }));

    const kinds = [...panelOf(doc).querySelectorAll('li')].map((li) => (li.textContent ?? '').split(' · ')[0]);
    expect(kinds).toEqual(['boilerplate', 'claim', 'boilerplate']);
  });

  it('restores every duplicate on destroy', () => {
    const { doc, passages } = docWithDuplicates(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    handle.apply(verdict('rd:same', 'highlight', { kind: 'boilerplate' }));

    handle.destroy();

    expect(doc.querySelectorAll('.jd-hl, .jd-dim, .jd-rtag')).toHaveLength(0);
  });
});

describe('runReading', () => {
  const ctx: DocContext = { title: 'T', lead: 'L', source: 'https://example.test/p' };

  /** A `send` that answers every readPassages batch by highlighting the first passage in it. */
  function sendSpy(over: (req: Request) => Response | undefined = () => undefined) {
    const calls: Request[] = [];
    const fn = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(structuredClone(req));
      const custom = over(req);
      if (custom) return custom;
      if (req.type !== 'readPassages') return { ok: false, error: 'unhandled' };
      return {
        ok: true,
        type: 'readPassages',
        focus: 'the question',
        verdicts: req.passages.map((p, i) => verdict(p.id, i === 0 ? 'highlight' : 'plain')),
        usageTokens: 10 * req.passages.length,
        errors: 0,
      };
    });
    return { calls, send: fn as unknown as typeof send };
  }

  it('sends batches of twelve in document order, with no DOM in the message', async () => {
    const { doc, passages } = docWith(20);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const spy = sendSpy();

    const summary = await runReading({ handle, ctx, passages, send: spy.send });

    const batches = spy.calls.filter((c) => c.type === 'readPassages');
    expect(batches).toHaveLength(2);
    if (batches[0].type !== 'readPassages' || batches[1].type !== 'readPassages') throw new Error('expected readPassages');
    expect(batches[0].passages).toHaveLength(12);
    expect(batches[1].passages).toHaveLength(8);
    expect(batches[0].passages[0]).toEqual({ id: 'rd:0', index: 0, text: passages[0].text, page: undefined });
    expect(summary.usageTokens).toBe(200);
    expect(summary.errors).toBe(0);
  });

  it('applies each batch as it lands, shows the focus once, and finishes', async () => {
    const { doc, passages } = docWith(13);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    await runReading({ handle, ctx, passages, send: sendSpy().send });

    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(2); // one per batch
    expect(panelOf(doc).querySelector('.focus')?.textContent).toBe('focus: the question');
    expect(panelOf(doc).querySelector('.progress')?.textContent).toMatch(/^13 passages · /);
  });

  it('counts a batch the background could not answer as errors, and applies nothing', async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    const summary = await runReading({ handle, ctx, passages, send: sendSpy(() => ({ ok: false, error: 'no response from background' })).send });

    expect(summary.errors).toBe(5);
    expect(doc.querySelectorAll('.jd-hl, .jd-dim')).toHaveLength(0);
    expect(panelOf(doc).querySelector('.progress')?.textContent).toContain('· 5 errors');
  });

  it('honours a smaller batch size', async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const spy = sendSpy();

    await runReading({ handle, ctx, passages, send: spy.send, batchSize: 2 });

    expect(spy.calls.filter((c) => c.type === 'readPassages')).toHaveLength(3);
  });

  // --- Fix round 1: destroying the reader while a batch is in flight must stop the loop, not just the UI ---

  it('a reply that arrives after the handle is destroyed applies nothing, sends no further batch, and skips finish', async () => {
    const { doc, passages } = docWith(20); // 2 batches at the default size (12 + 8)
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const finishSpy = vi.spyOn(handle, 'finish');
    const calls: Request[] = [];
    const fn = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(structuredClone(req));
      if (req.type !== 'readPassages') return { ok: false, error: 'unhandled' };
      // Simulates the user closing the reader while this very reply was still in flight: by the time
      // runReading's `await` resumes, the panel is already gone.
      if (calls.length === 1) handle.destroy();
      return { ok: true, type: 'readPassages', focus: 'q', verdicts: req.passages.map((p) => verdict(p.id, 'highlight')), usageTokens: 10, errors: 0 };
    });

    await runReading({ handle, ctx, passages, send: fn as unknown as typeof send });

    expect(fn).toHaveBeenCalledTimes(1); // no second batch was ever sent
    expect(doc.querySelectorAll('.jd-hl')).toHaveLength(0); // the reply that arrived after destroy applied nothing
    expect(finishSpy).not.toHaveBeenCalled();
  });

  it('applies a batch that lands before destruction, but discards one destroyed mid-flight and stops there', async () => {
    const { doc, passages } = docWith(30); // 3 batches at size 12: 12, 12, 6
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    // A spy (not a DOM check): destroy() itself unconditionally strips every jd-hl/jd-dim it or any
    // earlier batch added — restoring the page is the whole point — so the DOM alone can't tell
    // "batch 2's verdicts were never applied" apart from "they were applied and then wiped along with
    // batch 1's". Counting the calls can.
    const applySpy = vi.spyOn(handle, 'apply');
    const calls: Request[] = [];
    const fn = vi.fn(async (req: Request): Promise<Response> => {
      calls.push(structuredClone(req));
      if (req.type !== 'readPassages') return { ok: false, error: 'unhandled' };
      const res: Response = { ok: true, type: 'readPassages', focus: 'q', verdicts: req.passages.map((p) => verdict(p.id, 'highlight')), usageTokens: 10, errors: 0 };
      if (calls.length === 2) handle.destroy(); // the SECOND reply is the one still in flight at close time
      return res;
    });

    await runReading({ handle, ctx, passages, send: fn as unknown as typeof send, batchSize: 12 });

    expect(fn).toHaveBeenCalledTimes(2); // the third batch (passages 24..29) was never sent
    expect(applySpy).toHaveBeenCalledTimes(12); // only the first (undestroyed) batch's verdicts were applied
    expect(doc.querySelectorAll('.jd-hl, .jd-dim, .jd-rtag')).toHaveLength(0); // destroy() restored the page
  });

  // --- Design addendum 2026-09-23 §3.1: the summary carries the reason, not just the count ---

  it("carries a failed batch's error into the summary", async () => {
    const { doc, passages } = docWith(5);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const send = sendSpy(() => ({ ok: false, error: 'unknown request type: readPassages' })).send;

    const summary = await runReading({ handle, ctx, passages, send });

    expect(summary.errors).toBe(5);
    expect(summary.lastError).toBe('unknown request type: readPassages');
  });

  it('keeps the FIRST error in batch order, not the last', async () => {
    const { doc, passages } = docWith(4);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    let n = 0;
    const send = sendSpy(() => {
      n += 1;
      return { ok: false, error: `batch ${n} failed` };
    }).send;

    const summary = await runReading({ handle, ctx, passages, send, batchSize: 2 });

    expect(summary.lastError).toBe('batch 1 failed');
  });

  it("carries a reply's own lastError when no batch failed outright", async () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });
    const send = sendSpy((req) =>
      req.type === 'readPassages'
        ? { ok: true, type: 'readPassages', focus: '', verdicts: [], usageTokens: 0, errors: 1, lastError: 'invalid api key' }
        : undefined,
    ).send;

    const summary = await runReading({ handle, ctx, passages, send });

    expect(summary.errors).toBe(1);
    expect(summary.lastError).toBe('invalid api key');
  });

  it('leaves lastError absent when nothing failed at all', async () => {
    const { doc, passages } = docWith(3);
    const handle = mountReader(doc, { passages, focus: '', onClose: () => {} });

    const summary = await runReading({ handle, ctx, passages, send: sendSpy().send });

    expect(summary.errors).toBe(0);
    expect(summary.lastError).toBeUndefined();
  });
});
