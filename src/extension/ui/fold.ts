// Fold UI: pure DOM manipulation for a single judged post. content.ts calls `applyPending` while a
// post's judge request is in flight, `clearPending` once the response (or a send failure) arrives, and
// `mountDecision` to actually render a non-pending decision. No chrome.* calls happen here — the
// `FoldHandlers` passed in are content.ts's bridge to `send({type:'feedback', ...})`.

import type { Decision, Item } from '../../core/types';
import type { FoldHandlers } from '../adapters/types';

export type Mounted = { unmount(): void };

const PENDING_ATTR = 'data-jd';
const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** Marks `targets` as awaiting a verdict (`[data-jd="pending"]`; styles.css may use it for a subtle
 * loading treatment). Always paired with a later `clearPending` — see content.ts's fail-open handling. */
export function applyPending(targets: Element[]): void {
  for (const t of targets) t.setAttribute(PENDING_ATTR, 'pending');
}

export function clearPending(targets: Element[]): void {
  for (const t of targets) t.removeAttribute(PENDING_ATTR);
}

// Decision's fold/dim/badge member shares one shape with `kind` typed as the 3-way literal union, so
// `Extract<Decision, { kind: 'fold' }>` (a single literal) would collapse to `never` — matching the
// same union instead correctly picks out that whole member.
type FoldableDecision = Extract<Decision, { kind: 'fold' | 'dim' | 'badge' }>;

function mountFold(targets: Element[], decision: FoldableDecision, item: Item, handlers: FoldHandlers): Mounted {
  const first = targets[0];
  for (const t of targets) t.classList.add('jd-folded');

  const bar = document.createElement('div');
  bar.className = 'jd-bar';
  bar.setAttribute('data-jd-rule', decision.ruleId);
  const label = document.createTextNode(`⚡ ${decision.label} ${pct(decision.p)} `);
  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'jd-show';
  showBtn.textContent = 'Show';
  const wrongBtn = document.createElement('button');
  wrongBtn.type = 'button';
  wrongBtn.className = 'jd-wrong';
  wrongBtn.textContent = 'Wrong';
  bar.append(label, showBtn, wrongBtn);
  first?.before(bar);

  // Setting textContent both updates the label and drops the (now-detached) buttons in one step.
  function reveal(): void {
    for (const t of targets) t.classList.remove('jd-folded');
    bar.textContent = `⚡ shown · ${decision.label} ${pct(decision.p)}`;
  }
  showBtn.addEventListener('click', reveal);
  wrongBtn.addEventListener('click', () => {
    reveal();
    handlers.onWrong(item, decision);
  });

  return {
    unmount() {
      for (const t of targets) t.classList.remove('jd-folded');
      bar.remove();
    },
  };
}

function mountTag(el: Element, targets: Element[], text: string, dim: boolean): Mounted {
  if (dim) for (const t of targets) t.classList.add('jd-dimmed');
  const tag = document.createElement('span');
  tag.className = 'jd-tag';
  tag.textContent = text;
  el.prepend(tag);
  return {
    unmount() {
      if (dim) for (const t of targets) t.classList.remove('jd-dimmed');
      tag.remove();
    },
  };
}

function mountHideButton(el: Element, item: Item, decision: Decision, handlers: FoldHandlers): Mounted {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jd-hide';
  btn.textContent = 'hide this';
  btn.addEventListener('click', () => handlers.onHideThis(item, decision));
  el.append(btn);
  return { unmount() { btn.remove(); } };
}

/** Renders a final (non-pending) `Decision` for one post. Caller must have already called
 * `clearPending` — this function never touches the pending marker itself. */
export function mountDecision(el: Element, targets: Element[], item: Item, decision: Decision, handlers: FoldHandlers): Mounted {
  switch (decision.kind) {
    case 'fold':
      return mountFold(targets, decision, item, handlers);
    case 'dim':
      return mountTag(el, targets, `◐ ${decision.label} ${pct(decision.p)}`, true);
    case 'badge':
      return mountTag(el, targets, `◦ ${decision.label} ${pct(decision.p)}`, false);
    case 'keep':
      return decision.reason ? mountTag(el, targets, `★ kept: ${decision.reason}`, false) : mountHideButton(el, item, decision, handlers);
    default:
      // 'pending-arbiter' never reaches the fold UI: DuoAgent always resolves it before returning a
      // Verdict. Fail open rather than guess if that ever changes.
      return { unmount() {} };
  }
}
