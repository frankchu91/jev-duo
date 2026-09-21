import { describe, it, expect, vi } from 'vitest';
import { fetchHnFrontPage } from '../../../src/cli/sources/hn';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchHnFrontPage', () => {
  it('maps two hits to two Items with expected fields, HTML-stripped story_text, and a URL fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        hits: [
          {
            objectID: '111',
            title: 'Show HN: a new Rust web framework',
            url: 'https://example.com/rust-framework',
            points: 250,
            num_comments: 80,
            author: 'alice',
            story_text: '<p>Built with <b>async</b> traits &amp; friends.</p>',
          },
          {
            objectID: '222',
            title: 'Ask HN: how do you review PRs?',
            url: null,
            points: 40,
            num_comments: 12,
            author: 'bob',
            story_text: null,
          },
        ],
      }),
    );

    const items = await fetchHnFrontPage(2, fetchImpl);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'hn:111',
      platform: 'hn',
      author: 'alice',
      text: 'Show HN: a new Rust web framework\n\nBuilt with async traits & friends.',
      url: 'https://example.com/rust-framework',
      meta: { score: 250, comments: 80, hasLink: true },
    });
    expect(items[1]).toEqual({
      id: 'hn:222',
      platform: 'hn',
      author: 'bob',
      text: 'Ask HN: how do you review PRs?',
      url: 'https://news.ycombinator.com/item?id=222',
      meta: { score: 40, comments: 12, hasLink: false },
    });
  });

  it('requests the Algolia front_page search with the given limit as hitsPerPage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    await fetchHnFrontPage(15, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15');
  });

  // Real Algolia titles do carry newlines and runs of spaces; a title is one line by definition, and
  // the CLI table prints one line per item.
  it('collapses whitespace inside the title, before any story text is appended', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        hits: [
          { objectID: '333', title: 'Show HN: my thing\n\nSorry   for the long title', story_text: '<p>body</p>' },
          { objectID: '444', title: '  Ask HN:\twhat now?  ' },
        ],
      }),
    );

    const items = await fetchHnFrontPage(2, fetchImpl);
    expect(items[0].text).toBe('Show HN: my thing Sorry for the long title\n\nbody'); // title flattened, body untouched
    expect(items[1].text).toBe('Ask HN: what now?');
  });

  it('returns an empty array when there are no hits', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    expect(await fetchHnFrontPage(30, fetchImpl)).toEqual([]);
  });
});
