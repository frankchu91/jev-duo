// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Decision, Item } from '../../../src/core/types';
import { hnAdapter } from '../../../src/extension/adapters/hn';
import type { FoldHandlers } from '../../../src/extension/adapters/types';
import { applyPending, clearPending, mountDecision } from '../../../src/extension/ui/fold';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures');

const item: Item = { id: 'x:1', platform: 'x', text: 'hello' };

function noopHandlers(): FoldHandlers {
  return { onWrong: vi.fn(), onHideThis: vi.fn() };
}

function makeArticle(): HTMLElement {
  document.body.innerHTML = '<article>post body</article>';
  return document.body.querySelector('article')!;
}

describe('applyPending / clearPending', () => {
  it('sets and removes data-jd="pending" on every target', () => {
    const el = makeArticle();
    applyPending([el]);
    expect(el.getAttribute('data-jd')).toBe('pending');
    clearPending([el]);
    expect(el.hasAttribute('data-jd')).toBe(false);
  });
});

describe('mountDecision: fold', () => {
  const decision: Decision = { kind: 'fold', ruleId: 'crypto', label: 'Crypto', p: 0.92 };

  it('hides the targets and inserts a bar before the first target', () => {
    const el = makeArticle();
    mountDecision(el, [el], item, decision, noopHandlers());
    expect(el.classList.contains('jd-folded')).toBe(true);
    const bar = document.body.querySelector('.jd-bar');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute('data-jd-rule')).toBe('crypto');
    expect(bar?.textContent).toContain('Crypto');
    expect(bar?.textContent).toContain('92%');
    expect(bar?.nextElementSibling).toBe(el);
  });

  it('Show reveals the target, updates the bar text and removes the buttons', () => {
    const el = makeArticle();
    mountDecision(el, [el], item, decision, noopHandlers());
    const showBtn = document.body.querySelector<HTMLButtonElement>('.jd-show')!;
    showBtn.click();
    expect(el.classList.contains('jd-folded')).toBe(false);
    const bar = document.body.querySelector('.jd-bar')!;
    expect(bar.textContent).toBe('⚡ shown · Crypto 92%');
    expect(bar.querySelector('button')).toBeNull();
  });

  it('Wrong reveals the target and calls onWrong with the item and decision', () => {
    const el = makeArticle();
    const handlers = noopHandlers();
    mountDecision(el, [el], item, decision, handlers);
    const wrongBtn = document.body.querySelector<HTMLButtonElement>('.jd-wrong')!;
    wrongBtn.click();
    expect(el.classList.contains('jd-folded')).toBe(false);
    const bar = document.body.querySelector('.jd-bar')!;
    expect(bar.textContent).toBe('⚡ shown · Crypto 92%');
    expect(handlers.onWrong).toHaveBeenCalledWith(item, decision);
  });

  it('folds every target when there are several (e.g. HN row + subtext + spacer)', () => {
    document.body.innerHTML = '<table><tr id="row"></tr><tr id="sub"></tr><tr class="spacer"></tr></table>';
    const row = document.body.querySelector('#row')!;
    const sub = document.body.querySelector('#sub')!;
    const spacer = document.body.querySelector('.spacer')!;
    mountDecision(row, [row, sub, spacer], item, decision, noopHandlers());
    expect(row.classList.contains('jd-folded')).toBe(true);
    expect(sub.classList.contains('jd-folded')).toBe(true);
    expect(spacer.classList.contains('jd-folded')).toBe(true);
  });
});

// A bar inserted straight between two <tr>s is not renderable markup: browsers drop a stray <div>
// inside a table out of the row flow, so on HN the fold bar went missing. The adapter says how to
// wrap it; fold.ts only has to insert and remove the wrapper rather than the bar.
describe('mountDecision: fold with an adapter wrapBar (HN fixture)', () => {
  const decision: Decision = { kind: 'fold', ruleId: 'ragebait', label: 'Ragebait', p: 0.94 };

  function hnStory(): { row: Element; targets: Element[] } {
    document.body.innerHTML = readFileSync(path.join(FIXTURES, 'hn.html'), 'utf8');
    const row = hnAdapter.findPosts(document)[0];
    return { row, targets: hnAdapter.targets(row) };
  }

  it('inserts the bar as a table row before the story row, not as a bare div', () => {
    const { row, targets } = hnStory();
    mountDecision(row, targets, item, decision, noopHandlers(), hnAdapter.wrapBar);

    const barRow = document.body.querySelector('tr.jd-bar-row');
    expect(barRow).toBeTruthy();
    expect(barRow?.nextElementSibling).toBe(row);
    expect(barRow?.parentElement).toBe(row.parentElement); // a sibling row, inside the same table body

    const cell = barRow?.firstElementChild as HTMLTableCellElement;
    expect(cell.tagName).toBe('TD');
    expect(cell.colSpan).toBe(3);
    expect(cell.firstElementChild?.classList.contains('jd-bar')).toBe(true);
    expect(document.body.querySelector('.jd-bar')?.textContent).toContain('Ragebait');
  });

  it('Show still reveals the three folded rows through the wrapper', () => {
    const { row, targets } = hnStory();
    mountDecision(row, targets, item, decision, noopHandlers(), hnAdapter.wrapBar);
    expect(targets.filter((t) => t.classList.contains('jd-folded'))).toHaveLength(3);

    document.body.querySelector<HTMLButtonElement>('.jd-show')!.click();
    expect(targets.some((t) => t.classList.contains('jd-folded'))).toBe(false);
    expect(document.body.querySelector('tr.jd-bar-row')).toBeTruthy();
  });

  it('unmount removes the whole wrapper row, leaving no empty <tr> behind', () => {
    const { row, targets } = hnStory();
    const rowsBefore = document.body.querySelectorAll('tr').length;
    const mounted = mountDecision(row, targets, item, decision, noopHandlers(), hnAdapter.wrapBar);
    mounted.unmount();

    expect(document.body.querySelector('.jd-bar')).toBeNull();
    expect(document.body.querySelector('tr.jd-bar-row')).toBeNull();
    expect(document.body.querySelectorAll('tr')).toHaveLength(rowsBefore);
  });
});

describe('mountDecision: dim', () => {
  it('dims every target and prepends a tag with the ◐ glyph into el', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'dim', ruleId: 'clickbait', label: 'Clickbait', p: 0.61 };
    mountDecision(el, [el], item, decision, noopHandlers());
    expect(el.classList.contains('jd-dimmed')).toBe(true);
    const tag = el.querySelector('.jd-tag');
    expect(tag?.textContent).toBe('◐ Clickbait 61%');
    expect(el.firstElementChild).toBe(tag);
  });
});

describe('mountDecision: badge', () => {
  it('adds only the tag with the ◦ glyph, no dimming', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'badge', ruleId: 'promo', label: 'Promo', p: 0.55 };
    mountDecision(el, [el], item, decision, noopHandlers());
    expect(el.classList.contains('jd-dimmed')).toBe(false);
    expect(el.querySelector('.jd-tag')?.textContent).toBe('◦ Promo 55%');
  });
});

describe('mountDecision: keep', () => {
  it('with a reason adds a ★ kept tag', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'keep', reason: 'Rust' };
    mountDecision(el, [el], item, decision, noopHandlers());
    expect(el.querySelector('.jd-tag')?.textContent).toBe('★ kept: Rust');
    expect(el.querySelector('.jd-hide')).toBeNull();
  });

  it('without a reason adds only a hover-only hide-this button that calls onHideThis', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'keep' };
    const handlers = noopHandlers();
    mountDecision(el, [el], item, decision, handlers);
    expect(el.querySelector('.jd-tag')).toBeNull();
    const hideBtn = el.querySelector<HTMLButtonElement>('.jd-hide')!;
    expect(hideBtn.textContent).toBe('hide this');
    hideBtn.click();
    expect(handlers.onHideThis).toHaveBeenCalledWith(item, decision);
  });
});

describe('mountDecision: unmount', () => {
  it('fold unmount removes the bar and un-folds the targets', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'fold', ruleId: 'crypto', label: 'Crypto', p: 0.92 };
    const mounted = mountDecision(el, [el], item, decision, noopHandlers());
    mounted.unmount();
    expect(el.classList.contains('jd-folded')).toBe(false);
    expect(document.body.querySelector('.jd-bar')).toBeNull();
  });

  it('dim unmount removes the tag and un-dims the target', () => {
    const el = makeArticle();
    const decision: Decision = { kind: 'dim', ruleId: 'clickbait', label: 'Clickbait', p: 0.61 };
    const mounted = mountDecision(el, [el], item, decision, noopHandlers());
    mounted.unmount();
    expect(el.classList.contains('jd-dimmed')).toBe(false);
    expect(el.querySelector('.jd-tag')).toBeNull();
  });
});
