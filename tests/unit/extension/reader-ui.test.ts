// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DocContext, Passage, ReadingVerdict } from '../../../src/core/reading';
import type { ArticlePassage } from '../../../src/extension/reading/article';
import { mountReader, READER_CSS } from '../../../src/extension/reading/reader-ui';
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
});
