// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickAdapter } from '../../../src/extension/adapters/index';
import { genericAdapter } from '../../../src/extension/adapters/generic';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string): Document {
  const html = readFileSync(path.join(FIXTURES, name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

describe('genericAdapter', () => {
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

    it('url falls back to location.href for posts with no external link', () => {
      const doc = loadDoc('generic.html');
      const posts = genericAdapter.findPosts(doc);
      expect(genericAdapter.extract(posts[0])?.url).toBe(location.href);
      expect(genericAdapter.extract(posts[3])?.url).toBe(location.href);
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
    const doc = parse(`
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

    // A competing group of 7 elsewhere: fewer than double the cached 12 (needs >= 12) — moot anyway,
    // since the cached .timeline parent is still in the document, so it's never even reconsidered.
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
});
