// news.ycombinator.com adapter. Selectors fetched live 2026-09-21 (front page) — see
// adapters/README.md. A story is three sibling `<tr>`s (`athing submission`, its subtext row, a
// spacer row); `targets` returns all three so folding hides the whole block, not just the title row.

import { fnv1a } from '../../core/hash';
import type { Item, ItemMeta } from '../../core/types';
import type { Adapter } from './types';

function subtextRowOf(el: Element): Element | undefined {
  const next = el.nextElementSibling;
  return next && next.querySelector('td.subtext') ? next : undefined;
}

function spacerRowOf(subtext: Element | undefined): Element | undefined {
  const next = subtext?.nextElementSibling;
  return next?.classList.contains('spacer') ? next : undefined;
}

function commentsOf(subtext: Element | undefined): number | undefined {
  if (!subtext) return undefined;
  const links = [...subtext.querySelectorAll('a[href^="item?id="]')];
  const lastText = links[links.length - 1]?.textContent ?? '';
  if (/discuss/i.test(lastText)) return 0;
  const digits = lastText.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : undefined;
}

export const hnAdapter: Adapter = {
  platform: 'hn',

  matches(url) {
    return url.hostname === 'news.ycombinator.com';
  },

  findPosts(root) {
    return [...root.querySelectorAll('tr.athing.submission')];
  },

  extract(el) {
    const link = el.querySelector('.titleline > a');
    if (!link) return null;
    const title = (link.textContent ?? '').trim();
    const url = link.getAttribute('href') ?? undefined;
    const domain = el.querySelector('.titleline .sitestr')?.textContent?.trim();
    const text = domain ? `${title} (${domain})` : title;

    const rowId = el.getAttribute('id');
    const id = rowId ? `hn:${rowId}` : `hn:h${fnv1a(text)}`;

    const subtext = subtextRowOf(el);
    const scoreText = subtext?.querySelector('.score')?.textContent;
    const score = scoreText ? parseInt(scoreText, 10) : undefined;
    const author = subtext?.querySelector('a.hnuser')?.textContent?.trim();

    // A self post links to its own discussion (`item?id=...`), which is not an outbound link; neither
    // is a missing href — `!url?.startsWith(...)` used to report `true` for that second case.
    const meta: ItemMeta = { hasLink: !!url && !url.startsWith('item?id='), score, comments: commentsOf(subtext) };

    return { id, platform: 'hn', author, text, url, meta };
  },

  targets(el) {
    const subtext = subtextRowOf(el);
    const spacer = spacerRowOf(subtext);
    return [el, subtext, spacer].filter((x): x is Element => !!x);
  },

  /** A story row is a `<tr>` inside the front-page table, so the fold bar has to be a row too —
   * colspan 3 to match the title row's rank / votelinks / title cells. */
  wrapBar(bar) {
    const doc = bar.ownerDocument;
    const row = doc.createElement('tr');
    row.className = 'jd-bar-row';
    const cell = doc.createElement('td');
    cell.colSpan = 3;
    cell.appendChild(bar);
    row.appendChild(cell);
    return row;
  },
};
