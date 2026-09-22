// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pickAdapter } from '../../../src/extension/adapters/index';
import { hnAdapter } from '../../../src/extension/adapters/hn';
import { redditAdapter } from '../../../src/extension/adapters/reddit';
import { xAdapter } from '../../../src/extension/adapters/x';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string): Document {
  const html = readFileSync(path.join(FIXTURES, name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('xAdapter', () => {
  const doc = loadDoc('x.html');

  it('matches x.com, twitter.com, pro.x.com and their subdomains, not other hosts', () => {
    expect(xAdapter.matches(new URL('https://x.com/home'))).toBe(true);
    expect(xAdapter.matches(new URL('https://twitter.com/home'))).toBe(true);
    expect(xAdapter.matches(new URL('https://pro.x.com/home'))).toBe(true);
    expect(xAdapter.matches(new URL('https://mobile.x.com/home'))).toBe(true);
    expect(xAdapter.matches(new URL('https://example.com'))).toBe(false);
  });

  it('findPosts finds exactly the 6 outermost tweets, excluding the nested quoted article', () => {
    expect(xAdapter.findPosts(doc)).toHaveLength(6);
  });

  it('extracts id from the status link, author, text and url on the first tweet', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[0]);
    expect(item?.id).toBe('x:1700000000000000001');
    expect(item?.author).toBe('@moon_gains');
    expect(item?.text).toContain('DOGE2');
    expect(item?.url).toBe('https://x.com/moon_gains/status/1700000000000000001');
  });

  it('marks the promoted 5th tweet as isPromoted and detects its link', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[4]);
    expect(item?.meta?.isPromoted).toBe(true);
    expect(item?.meta?.hasLink).toBe(true);
  });

  it('has no link/media on the plain Rust tweet', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[3]);
    expect(item?.meta?.hasLink).toBe(false);
    expect(item?.meta?.hasMedia).toBe(false);
  });

  it('detects attached media on the ragebait tweet', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[2]);
    expect(item?.meta?.hasMedia).toBe(true);
  });

  it('detects a reply via a div[dir] whose own text starts with "Replying to "', () => {
    const el = loadDoc('x.html').createElement('article');
    el.setAttribute('data-testid', 'tweet');
    el.innerHTML = [
      '<div dir="ltr">Replying to <a href="/someone">@someone</a></div>',
      '<div data-testid="User-Name"><span>Name</span><span tabindex="-1">@replier</span></div>',
      '<a href="/replier/status/1700000000000000123"><time datetime="2026-09-21T02:00:00Z">2h</time></a>',
      '<div data-testid="tweetText">Totally agree with this take.</div>',
    ].join('');
    const item = xAdapter.extract(el);
    expect(item?.meta?.isReply).toBe(true);
  });

  it('does not flag isReply when there is no "Replying to " div', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[3]);
    expect(item?.meta?.isReply).toBe(false);
  });

  it('appends the nested quoted tweet text on the 6th tweet without counting it as a separate post', () => {
    const item = xAdapter.extract(xAdapter.findPosts(doc)[5]);
    expect(item?.text).toContain('Solid point about incremental refactors');
    expect(item?.text).toContain('[quoted] Reminder: always write tests before refactoring.');
  });

  it('targets() returns just the article itself', () => {
    const posts = xAdapter.findPosts(doc);
    expect(xAdapter.targets(posts[0])).toEqual([posts[0]]);
  });

  it('falls back to a content-hash id when there is no status link', () => {
    const el = loadDoc('x.html').createElement('article');
    el.setAttribute('data-testid', 'tweet');
    el.innerHTML = '<div data-testid="tweetText">no status link here</div>';
    const item = xAdapter.extract(el);
    expect(item?.id).toMatch(/^x:h\d+$/);
  });

  it('returns null (not judgeable) for a tweet with no tweetText', () => {
    const el = loadDoc('x.html').createElement('article');
    el.setAttribute('data-testid', 'tweet');
    expect(xAdapter.extract(el)).toBeNull();
  });
});

describe('redditAdapter', () => {
  const doc = loadDoc('reddit.html');

  it('matches reddit.com and subdomains, not other hosts', () => {
    expect(redditAdapter.matches(new URL('https://www.reddit.com/r/test'))).toBe(true);
    expect(redditAdapter.matches(new URL('https://old.reddit.com/r/test'))).toBe(true);
    expect(redditAdapter.matches(new URL('https://example.com'))).toBe(false);
  });

  it('findPosts finds the 4 shreddit-post elements, ignoring the shreddit-ad-post', () => {
    expect(redditAdapter.findPosts(doc)).toHaveLength(4);
  });

  it('extracts a text post with title+body, author, url, score and comments', () => {
    const item = redditAdapter.extract(redditAdapter.findPosts(doc)[0]);
    expect(item?.id).toBe('reddit:t3_b1aa11');
    expect(item?.author).toBe('devuser1');
    expect(item?.text).toContain('Why I switched from Vim to Helix');
    expect(item?.text).toContain("Helix's built-in LSP support");
    expect(item?.url).toBe('https://www.reddit.com/r/neovim/comments/b1aa11/why_i_switched_from_vim_to_helix/');
    expect(item?.meta?.score).toBe(142);
    expect(item?.meta?.comments).toBe(58);
    expect(item?.meta?.hasLink).toBe(false);
  });

  it('extracts a link post with no text body and hasLink true', () => {
    const item = redditAdapter.extract(redditAdapter.findPosts(doc)[2]);
    expect(item?.text).toBe('Rust 1.90 released with new borrow checker improvements');
    expect(item?.meta?.hasLink).toBe(true);
  });

  it('detects hasMedia for an image post-type', () => {
    const el = loadDoc('reddit.html').createElement('shreddit-post');
    el.setAttribute('id', 't3_img1');
    el.setAttribute('post-title', 'Cool screenshot from the conference');
    el.setAttribute('post-type', 'image');
    el.setAttribute('author', 'photo_poster');
    const item = redditAdapter.extract(el);
    expect(item?.meta?.hasMedia).toBe(true);
    expect(item?.meta?.hasLink).toBe(false);
  });

  it('targets() returns just the shreddit-post itself', () => {
    const posts = redditAdapter.findPosts(doc);
    expect(redditAdapter.targets(posts[0])).toEqual([posts[0]]);
  });
});

describe('hnAdapter', () => {
  const doc = loadDoc('hn.html');

  it('matches only news.ycombinator.com', () => {
    expect(hnAdapter.matches(new URL('https://news.ycombinator.com/'))).toBe(true);
    expect(hnAdapter.matches(new URL('https://example.com'))).toBe(false);
  });

  it('findPosts finds the 5 story rows', () => {
    expect(hnAdapter.findPosts(doc)).toHaveLength(5);
  });

  it('extracts title, url, domain, score, author and comments for a normal story', () => {
    const item = hnAdapter.extract(hnAdapter.findPosts(doc)[0]);
    expect(item?.id).toBe('hn:41000001');
    expect(item?.text).toBe('Grim Fandango Puzzle Document (1996) [pdf] (jmac.org)');
    expect(item?.url).toBe('http://gameshelf.jmac.org/2008/11/13/GrimPuzzleDoc_small.pdf');
    expect(item?.author).toBe('kelseyfrog');
    expect(item?.meta?.score).toBe(58);
    expect(item?.meta?.comments).toBe(7);
    expect(item?.meta?.hasLink).toBe(true);
  });

  it('extracts a self post (Ask HN) with no domain and an item?id= url', () => {
    const item = hnAdapter.extract(hnAdapter.findPosts(doc)[1]);
    expect(item?.text).toBe('Ask HN: How do you evaluate LLM agent frameworks?');
    expect(item?.url).toBe('item?id=41000002');
    expect(item?.meta?.hasLink).toBe(false);
    expect(item?.meta?.comments).toBe(62);
  });

  it('reports hasLink:false for a title link with no href at all (not just an item?id= one)', () => {
    const row = hnAdapter.findPosts(doc)[0].cloneNode(true) as Element;
    row.querySelector('.titleline > a')!.removeAttribute('href');
    expect(hnAdapter.extract(row)?.meta?.hasLink).toBe(false);
  });

  it('targets() returns the row plus its subtext row and spacer row', () => {
    const el = hnAdapter.findPosts(doc)[0];
    const targets = hnAdapter.targets(el);
    expect(targets).toHaveLength(3);
    expect(targets[0]).toBe(el);
    expect(targets[1].querySelector('td.subtext')).toBeTruthy();
    expect(targets[2].classList.contains('spacer')).toBe(true);
  });
});

describe('pickAdapter', () => {
  it('honours the jd-platform override regardless of hostname', () => {
    expect(pickAdapter(new URL('http://localhost:4173/x.html?jd-platform=x'))?.platform).toBe('x');
    expect(pickAdapter(new URL('http://127.0.0.1:4173/reddit.html?jd-platform=reddit'))?.platform).toBe('reddit');
    expect(pickAdapter(new URL('http://127.0.0.1:4173/hn.html?jd-platform=hn'))?.platform).toBe('hn');
  });

  it('matches by hostname when there is no override', () => {
    expect(pickAdapter(new URL('https://x.com/'))?.platform).toBe('x');
    expect(pickAdapter(new URL('https://www.reddit.com/'))?.platform).toBe('reddit');
    expect(pickAdapter(new URL('https://news.ycombinator.com/'))?.platform).toBe('hn');
  });

  // Spec §3: genericAdapter.matches is unconditionally true, so it is the fallback for any URL none of
  // the three built-ins claim — pickAdapter can no longer return undefined for a real URL.
  it('falls back to the generic adapter for an unrelated site', () => {
    expect(pickAdapter(new URL('https://example.com/'))?.platform).toBe('generic');
  });

  it('ignores an unrecognized jd-platform value and falls back to hostname matching', () => {
    expect(pickAdapter(new URL('https://x.com/?jd-platform=bogus'))?.platform).toBe('x');
  });
});
