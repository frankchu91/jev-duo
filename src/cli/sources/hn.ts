import type { Item } from '../../core/index.js';

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const STORY_TEXT_MAX_CHARS = 1500;

interface HnHit {
  objectID: string;
  title: string;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  author?: string;
  story_text?: string | null;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>',
};

/** Strips tags and decodes the handful of HTML entities Algolia's `story_text` commonly carries. */
function stripHtml(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, '');
  return withoutTags.replace(/&amp;|&quot;|&#x27;|&#39;|&lt;|&gt;/g, (m) => HTML_ENTITIES[m]);
}

function toItem(hit: HnHit): Item {
  const text = hit.story_text
    ? `${hit.title}\n\n${stripHtml(hit.story_text).slice(0, STORY_TEXT_MAX_CHARS)}`
    : hit.title;
  return {
    id: `hn:${hit.objectID}`,
    platform: 'hn',
    author: hit.author,
    text,
    url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
    meta: { score: hit.points ?? undefined, comments: hit.num_comments ?? undefined, hasLink: !!hit.url },
  };
}

/** Fetches the Hacker News front page via the Algolia search API and maps each hit to an `Item`. */
export async function fetchHnFrontPage(limit: number, fetchImpl: typeof fetch = fetch): Promise<Item[]> {
  const url = `${HN_SEARCH_URL}?tags=front_page&hitsPerPage=${limit}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`hn: front page request failed with HTTP ${res.status}`);
  const body = (await res.json()) as { hits: HnHit[] };
  return body.hits.map(toItem);
}
