// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickAdapter } from '../../../src/extension/adapters/index';
import { __generic, genericAdapter } from '../../../src/extension/adapters/generic';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string): Document {
  const html = readFileSync(path.join(FIXTURES, name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

/** A page with no feed at all: the only repeated-tag sibling groups (4 `<h2>`s, 4 `<p>`s) are both far
 * short of MIN_TEXT, so every scan of it returns nothing. Used twice below — once for the fail-closed
 * result, once for the no-cache throttle that keeps a page like this from being re-scanned forever. */
const DOCS_PAGE = `
  <header><h1>Getting Started</h1></header>
  <article>
    <h2>Installation</h2>
    <p>See installation steps below.</p>
    <h2>Configuration</h2>
    <p>Config lives in a yaml file.</p>
    <h2>Usage</h2>
    <p>Run with --config set.</p>
    <h2>FAQ</h2>
    <p>Check the FAQ page.</p>
  </article>
`;

describe('genericAdapter', () => {
  // `__generic` is the fix-round-2 test hook (clock override + cache reset) for the full-scan throttle;
  // every test starts from a clean cache and the real clock, regardless of what an earlier test did.
  beforeEach(() => {
    __generic.reset();
  });
  afterEach(() => {
    __generic.now = () => Date.now();
    vi.restoreAllMocks();
  });

  it('matches every URL (pickAdapter is what keeps it off the built-in hosts)', () => {
    expect(genericAdapter.matches(new URL('https://anything.example/'))).toBe(true);
  });

  // (a) findPosts on the Mastodon-like fixture: 6 outermost statuses, the nested quote and the nav
  // menu excluded.
  it('findPosts returns exactly the 6 outermost status articles, excluding the nested quote and the nav items', () => {
    const doc = loadDoc('generic.html');
    const posts = genericAdapter.findPosts(doc);
    expect(posts).toHaveLength(6);
    expect(posts.every((el) => el.classList.contains('status'))).toBe(true);
    expect(posts.some((el) => el.classList.contains('quoted'))).toBe(false);
    expect(posts.some((el) => el.closest('nav'))).toBe(false);
  });

  // Fix wave, C2 (spec §3.4): "outermost only" is a structural guarantee, not a filter — every member
  // of a group is a direct child of the same parent, so no returned element can contain another. The
  // O(n^2) `outermost()` pass that used to re-check this on every call is gone; this test is what keeps
  // the invariant honest.
  it('never returns a post contained inside another (outermost-only holds by construction)', () => {
    const doc = loadDoc('generic.html');
    const posts = genericAdapter.findPosts(doc);
    expect(posts).toHaveLength(6);
    const nested = posts.filter((el) => posts.some((other) => other !== el && other.contains(el)));
    expect(nested).toEqual([]);
  });

  // (b) extraction fields, id stability, author, hasMedia/hasLink/url.
  describe('extract', () => {
    it('gives platform generic, a stable g: id across two calls, and the author from .display-name', () => {
      const doc = loadDoc('generic.html');
      const [first] = genericAdapter.findPosts(doc);
      const itemA = genericAdapter.extract(first);
      const itemB = genericAdapter.extract(first);
      expect(itemA?.platform).toBe('generic');
      expect(itemA?.id).toMatch(/^g:\d+$/);
      expect(itemA?.id).toBe(itemB?.id);
      expect(itemA?.author).toBe('Moon Signals');
    });

    it('hasMedia is true only for the post with the image', () => {
      const doc = loadDoc('generic.html');
      const posts = genericAdapter.findPosts(doc);
      const flags = posts.map((el) => genericAdapter.extract(el)?.meta?.hasMedia ?? false);
      expect(flags).toEqual([false, false, true, false, false, false]);
    });

    it('hasLink is true only for the post with the external link, and url is that link', () => {
      const doc = loadDoc('generic.html');
      const posts = genericAdapter.findPosts(doc);
      const flags = posts.map((el) => genericAdapter.extract(el)?.meta?.hasLink ?? false);
      expect(flags).toEqual([false, false, false, false, true, false]);
      expect(genericAdapter.extract(posts[4])?.url).toBe('https://eng.example.com/retro');
    });

    // Fix wave, A/minor: the author's OWN link (a profile card that wraps the handle in an <a>) is not
    // the post's url. Skipping only the author element itself left the wrapper case broken, since the
    // matched author element is then the wrapper and the link inside it is a different node.
    it('url skips a link nested inside the author element, not just the author element itself', () => {
      const doc = parse(`
        <article class="post">
          <div class="author-card"><a href="https://social.example/users/alice">Alice Ackerman</a></div>
          <p>A real post body with plenty of genuinely visible text to clear the forty character minimum.</p>
          <a href="https://blog.example/the-post">read the whole thing</a>
        </article>
      `);
      const item = genericAdapter.extract(doc.querySelector('.post')!);
      expect(item?.author).toBe('Alice Ackerman'); // the wrapper matched [class*="author" i], not the <a>
      expect(item?.url).toBe('https://blog.example/the-post');
    });

    it('url falls back to location.href for posts with no external link', () => {
      const doc = loadDoc('generic.html');
      const posts = genericAdapter.findPosts(doc);
      expect(genericAdapter.extract(posts[0])?.url).toBe(location.href);
      expect(genericAdapter.extract(posts[3])?.url).toBe(location.href);
    });

    // Fix round 1, IMPORTANT #1 (spec §3.2): extracted text is VISIBLE text — an inline <style> block
    // and an aria-hidden span must not leak into it.
    it("excludes an inline <style> block and an aria-hidden span from the extracted text", () => {
      const doc = parse(`
        <article class="post">
          <style>.post { color: red; }</style>
          Some genuinely visible lead-in text for this post that is long enough to qualify on its own.
          <span aria-hidden="true">SECRET_HIDDEN_MARKER</span>
        </article>
      `);
      const el = doc.querySelector('.post')!;
      const text = genericAdapter.extract(el)?.text ?? '';
      expect(text).not.toContain('color: red');
      expect(text).not.toContain('SECRET_HIDDEN_MARKER');
      expect(text).toContain('Some genuinely visible lead-in text');
    });

    // Fix round 2, MINOR 2: HIDDEN_STYLE needs a word boundary after none/hidden, or "display:nonesuch"
    // and "visibility:hiddenpopup" (neither of which actually hides anything) would be treated as
    // hidden too. `!important` must still match — the boundary sits right after "none"/"hidden" either way.
    it('HIDDEN_STYLE requires a word boundary: nonesuch/hiddenpopup are not hidden, none/hidden (incl. !important) are', () => {
      const doc = parse(`
        <article class="post">
          Visible lead text that is long enough to clear the qualification minimum on its own already.
          <span style="display:none">HIDDEN_A</span>
          <span style="display: none !important">HIDDEN_B</span>
          <span style="visibility:hidden">HIDDEN_C</span>
          <span style="display:nonesuch">VISIBLE_D</span>
          <span style="visibility:hiddenpopup">VISIBLE_E</span>
        </article>
      `);
      const text = genericAdapter.extract(doc.querySelector('.post')!)?.text ?? '';
      expect(text).not.toContain('HIDDEN_A');
      expect(text).not.toContain('HIDDEN_B');
      expect(text).not.toContain('HIDDEN_C');
      expect(text).toContain('VISIBLE_D');
      expect(text).toContain('VISIBLE_E');
    });

    // Fix round 2, MINOR 1: visibleText is an iterative walk (explicit stack), not recursive, so it
    // must not throw (stack overflow) on an unusually deep chain of wrapper elements.
    it('visibleText walks a 5,000-deep nested <div> chain iteratively without throwing, and returns its leaf text', () => {
      const doc = parse('<article class="post" id="root"></article>');
      let el = doc.getElementById('root')!;
      for (let i = 0; i < 5000; i++) {
        const child = doc.createElement('div');
        el.appendChild(child);
        el = child;
      }
      el.textContent = 'Deep leaf text that is definitely long enough to clear the forty character minimum here.';
      const root = doc.getElementById('root')!;
      let text = '';
      expect(() => {
        text = genericAdapter.extract(root)?.text ?? '';
      }).not.toThrow();
      expect(text).toContain('Deep leaf text');
    });
  });

  // (c) generated classes (containing digits) are dropped from the signature, so 7 forum threads with
  // unique thread-N/css-N classes still group together as one repeated block.
  it('drops generated classes from the signature: 7 forum threads with unique thread-N/css-N classes group together', () => {
    const doc = parse('<ul class="threads"></ul>');
    const ul = doc.querySelector('ul.threads')!;
    const texts = [
      'Why does the build take fifteen minutes on a clean checkout now, it used to take under two minutes',
      'Looking for a maintainer to help review pull requests for the parser module this quarter',
      'Post-mortem: the outage last night was caused by a misconfigured retry loop in the queue worker',
      'Does anyone have a good writeup comparing the tradeoffs between polling and websockets for this',
      'Release notes for version 4.2 are up, the big change is the new plugin loading order',
      'Reminder that the community call is moved to Thursday this week because of the holiday',
      'A friendly thread to share what everyone is currently refactoring this sprint and why',
    ];
    texts.forEach((text, i) => {
      const li = doc.createElement('li');
      li.className = `thread thread-${4821 + i} css-1x9f${i}k`;
      li.textContent = text;
      ul.appendChild(li);
    });
    expect(genericAdapter.findPosts(doc)).toHaveLength(7);
  });

  // (d) a documentation page: the only repeated-tag sibling groups (4 <h2>s, 4 <p>s) are both far short
  // of MIN_TEXT, so nothing qualifies and findPosts fails closed to zero.
  it('finds nothing on a documentation page with no group of >= 4 similar, substantial siblings', () => {
    const doc = parse(DOCS_PAGE);
    expect(genericAdapter.findPosts(doc)).toEqual([]);
  });

  // Fix round 1, IMPORTANT #1 (spec §3.2): qualification uses VISIBLE text. 3 of 6 similar posts pad
  // their raw textContent past MIN_TEXT with a <script> and a `hidden` div but have only ~20 visible
  // chars of their own; those 3 must not qualify, dropping the group to 3 qualifying members (< 4), so
  // the whole group is rejected and findPosts fails closed to zero — not 3, not 6.
  it('excludes script and hidden-subtree text from qualification: 3 padded-but-short posts among 6 sink the group', () => {
    const filler = 'x'.repeat(200);
    const shortVisible = 'Not much to see here.'; // ~22 visible chars, well under MIN_TEXT
    const normal = (n: number) => `Real post number ${n} with plenty of genuinely visible text to clear the forty character minimum.`;
    const doc = parse(`
      <ul class="items">
        <li class="item">${shortVisible}<script>${filler}</script><div hidden>${filler}</div></li>
        <li class="item">${shortVisible}<script>${filler}</script><div hidden>${filler}</div></li>
        <li class="item">${shortVisible}<script>${filler}</script><div hidden>${filler}</div></li>
        <li class="item">${normal(1)}</li>
        <li class="item">${normal(2)}</li>
        <li class="item">${normal(3)}</li>
      </ul>
    `);
    expect(genericAdapter.findPosts(doc)).toEqual([]);
  });

  // (e) the largest repeated group on the page is a nav menu with long-enough labels to otherwise
  // qualify; landmark exclusion drops it entirely, so the smaller real feed of 4 posts wins.
  it('excludes a qualifying nav menu via landmark filtering, so a smaller real feed wins', () => {
    const doc = parse(`
      <nav>
        <ul>
          <li class="nav-item">Dashboard overview and analytics for your whole team in one place</li>
          <li class="nav-item">Project settings, billing, and workspace member management panel</li>
          <li class="nav-item">Notification preferences, integrations, and connected apps list</li>
          <li class="nav-item">Account security, sessions, and two factor authentication setup</li>
          <li class="nav-item">Help center, changelog, and product roadmap for this quarter</li>
        </ul>
      </nav>
      <main>
        <div class="feed">
          <div class="post">First real post with enough substance to clear the text threshold easily.</div>
          <div class="post">Second real post, also long enough to count as a qualifying member here.</div>
          <div class="post">Third real post continues the pattern with plenty of readable content.</div>
          <div class="post">Fourth real post rounds out the feed with more than enough characters.</div>
        </div>
      </main>
    `);
    const posts = genericAdapter.findPosts(doc);
    expect(posts).toHaveLength(4);
    expect(posts.every((el) => el.classList.contains('post'))).toBe(true);
  });

  // (f) pickAdapter: generic is the fallback for anything the built-ins don't claim, but never steals
  // a built-in host.
  it('pickAdapter falls through to generic for a non-built-in host, and still prefers x on x.com', () => {
    expect(pickAdapter(new URL('https://mastodon.social/home'))?.platform).toBe('generic');
    expect(pickAdapter(new URL('https://x.com/home'))?.platform).toBe('x');
  });

  // (g) cache + replacement rule: cheap re-collection picks up new siblings under the same cached
  // parent; a competing group elsewhere never displaces it while that parent is still in the document.
  it('grows the cached group cheaply on rescan, and a smaller competing group elsewhere never displaces it', () => {
    const doc = loadDoc('generic.html');
    expect(genericAdapter.findPosts(doc)).toHaveLength(6);

    const timeline = doc.querySelector('.timeline')!;
    const template = doc.querySelector('article.status.status-public')!;
    for (let i = 0; i < 6; i++) {
      const clone = template.cloneNode(true) as Element;
      clone.id = `status-extra-${i}`;
      clone.querySelector('.display-name')!.textContent = `Extra Poster ${i}`;
      clone.querySelector('.status__content p')!.textContent =
        `Extra generated post number ${i} with plenty of readable filler text to clear the threshold easily.`;
      timeline.appendChild(clone);
    }
    expect(genericAdapter.findPosts(doc)).toHaveLength(12);

    // A competing group of 7 elsewhere: irrelevant either way here, since the cheap per-parent recount
    // (not a full scan — see the throttle tests below) already reflects .timeline's own current 12
    // members correctly, and 7 wouldn't have displaced them even if a full scan did run (needs >= 24).
    const aside = doc.createElement('div');
    aside.className = 'sidebar';
    doc.body.appendChild(aside);
    for (let i = 0; i < 7; i++) {
      const card = doc.createElement('div');
      card.className = 'promo-card';
      card.textContent = `Sponsored card number ${i} with enough text to clear the forty character minimum easily.`;
      aside.appendChild(card);
    }
    expect(genericAdapter.findPosts(doc)).toHaveLength(12);
  });

  // Fix round 1, IMPORTANT #2 (spec §3.5, ruling): while the cached parent is still attached and still
  // qualifies on its own, a DIFFERENT group elsewhere only displaces it at >= 2x its member count.
  // Fix round 2: this now needs the throttled full scan to actually run (see "full-scan throttle"
  // below), so the clock is forced past FULL_SCAN_MIN_INTERVAL_MS before each check that depends on it.
  it('a different competing group only displaces a healthy, still-attached cached group at >= 2x its size', () => {
    const doc = loadDoc('generic.html');
    let clock = 1_000_000;
    __generic.now = () => clock;
    expect(genericAdapter.findPosts(doc)).toHaveLength(6); // warms the cache: .timeline, count 6

    const promo = doc.createElement('div');
    promo.className = 'promo';
    doc.body.appendChild(promo);
    const addCard = (i: number): void => {
      const card = doc.createElement('div');
      card.className = 'promo-card';
      card.textContent = `Sponsored card number ${i} with enough text to clear the forty character minimum easily.`;
      promo.appendChild(card);
    };
    for (let i = 0; i < 7; i++) addCard(i);

    clock += 5000; // force the throttled full scan to run on the very next call
    // 7 < 2 x 6 (needs >= 12): the cached, still fully-attached .timeline group is not displaced.
    const stillOld = genericAdapter.findPosts(doc);
    expect(stillOld).toHaveLength(6);
    expect(stillOld.every((el) => el.classList.contains('status'))).toBe(true);

    for (let i = 7; i < 12; i++) addCard(i); // grows the competing group to 12 == 2 x 6
    clock += 5000; // force another full scan

    // 12 >= 2 x 6: the competing group now displaces the cached one.
    const displaced = genericAdapter.findPosts(doc);
    expect(displaced).toHaveLength(12);
    expect(displaced.every((el) => el.classList.contains('promo-card'))).toBe(true);
  });

  // Fix round 1, IMPORTANT #2 (spec §3.5, ruling): once the cached parent is detached (the old feed is
  // gone), the next qualifying group found anywhere is adopted regardless of size — no 2x gate. Fix
  // round 2: also proves this happens as an IMMEDIATE full scan, not throttled — the spy call count is
  // checked right after the warm-up, well inside the 20-call/5000ms throttle window.
  it('a detached parent triggers a full scan immediately regardless of the throttle counter, and adopts the next group regardless of size', () => {
    const doc = loadDoc('generic.html');
    expect(genericAdapter.findPosts(doc)).toHaveLength(6); // warms the cache: .timeline, count 6

    doc.querySelector('.timeline')!.remove(); // the cached parent (and its 6 members) is now detached

    const list = doc.createElement('ul');
    list.className = 'threads';
    doc.body.appendChild(list);
    for (let i = 0; i < 4; i++) {
      const li = doc.createElement('li');
      li.className = 'thread';
      li.textContent = `A short new thread number ${i} with just enough text to clear the minimum here.`;
      list.appendChild(li);
    }

    const spy = vi.spyOn(doc, 'querySelectorAll');
    // Only 1 call since the warm-up — nowhere near the 20-call/5000ms throttle — yet the detach forces
    // an immediate full scan: the throttle only ever applies to a still-attached, still-healthy parent.
    const posts = genericAdapter.findPosts(doc);
    expect(spy).toHaveBeenCalledTimes(1);
    // Only 4 members — well under 2 x 6 (would need >= 12) — but the old parent is gone, so the
    // replacement gate doesn't apply at all.
    expect(posts).toHaveLength(4);
    expect(posts.every((el) => el.classList.contains('thread'))).toBe(true);
  });

  // Fix round 2, IMPORTANT (new): the full-scan throttle itself (spec §3.5).
  describe('full-scan throttle', () => {
    it('19 consecutive calls on a healthy, attached cached parent skip the full scan; the 20th runs it', () => {
      const doc = loadDoc('generic.html');
      expect(genericAdapter.findPosts(doc)).toHaveLength(6); // call 0 (warm-up): a full scan, cache set

      const spy = vi.spyOn(doc, 'querySelectorAll');
      for (let i = 0; i < 19; i++) genericAdapter.findPosts(doc);
      expect(spy).not.toHaveBeenCalled();

      genericAdapter.findPosts(doc); // the 20th call since the warm-up
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('advancing the injected clock by >= 5000ms triggers a full scan on the very next call', () => {
      const doc = loadDoc('generic.html');
      let clock = 1_000_000;
      __generic.now = () => clock;
      expect(genericAdapter.findPosts(doc)).toHaveLength(6); // warm-up: lastFullScanAt = 1_000_000

      const spy = vi.spyOn(doc, 'querySelectorAll');
      clock += 5000; // >= FULL_SCAN_MIN_INTERVAL_MS since the warm-up's full scan
      genericAdapter.findPosts(doc);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Fix wave, C1 (spec §3.5): the throttle used to apply only to a HEALTHY CACHED parent, so a page
    // with no qualifying feed at all — no cache to protect — full-scanned the whole document on every
    // MutationObserver rescan, for as long as the tab stayed open. The same 20-call / 5000ms budget now
    // covers the no-cache case, with the very first call (fresh counters) still scanning.
    it('a page with no qualifying feed scans once in 20 calls, and again on the 21st', () => {
      const doc = parse(DOCS_PAGE);
      let clock = 1_000_000;
      __generic.now = () => clock;
      const spy = vi.spyOn(doc, 'querySelectorAll');

      for (let i = 0; i < 20; i++) expect(genericAdapter.findPosts(doc)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1); // the first call; the other 19 never touched the document

      expect(genericAdapter.findPosts(doc)).toEqual([]); // the 21st
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a page with no qualifying feed re-scans once the injected clock passes 5000ms', () => {
      const doc = parse(DOCS_PAGE);
      let clock = 1_000_000;
      __generic.now = () => clock;
      const spy = vi.spyOn(doc, 'querySelectorAll');

      expect(genericAdapter.findPosts(doc)).toEqual([]); // fresh counters: scans
      expect(genericAdapter.findPosts(doc)).toEqual([]); // throttled
      expect(spy).toHaveBeenCalledTimes(1);

      clock += 5000;
      expect(genericAdapter.findPosts(doc)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  // Fix wave, I5: qualification, the median and the tie-break total used to walk every candidate's
  // subtree separately — three full visible-text walks per member per scan. One memo per `scan()` call
  // makes it one, which is what this counts: 6 candidates in one group, 6 walks.
  it('walks each candidate member\'s visible text exactly once per scan', () => {
    const items = Array.from(
      { length: 6 },
      (_, i) => `<li class="item">Feed item number ${'abcdef'[i]} with plenty of genuinely visible text to clear the minimum.</li>`,
    ).join('');
    const doc = parse(`<ul class="feed">${items}</ul>`);

    expect(genericAdapter.findPosts(doc)).toHaveLength(6);
    expect(__generic.textWalks()).toBe(6); // 6, not 18: one walk per member, not one per reader
  });
});
