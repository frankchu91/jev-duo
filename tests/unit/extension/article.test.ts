// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { passageId } from '../../../src/core/reading';
import { articleCandidates, extractArticle } from '../../../src/extension/reading/article';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../e2e/fixtures');

function loadDoc(name: string): Document {
  return new DOMParser().parseFromString(readFileSync(path.join(FIXTURES, name), 'utf8'), 'text/html');
}

function parse(body: string, head = ''): Document {
  return new DOMParser().parseFromString(`<html><head>${head}</head><body>${body}</body></html>`, 'text/html');
}

/** `n` paragraphs of `chars` characters each, each one distinct so no two share an id. */
function paragraphs(n: number, chars: number, prefix = 'para'): string {
  return Array.from({ length: n }, (_, i) => `<p>${prefix} ${i} ${'x'.repeat(Math.max(0, chars - `${prefix} ${i} `.length))}</p>`).join('');
}

describe('extractArticle on the arXiv-like fixture', () => {
  it('finds exactly the 21 body paragraphs, in document order', () => {
    const article = extractArticle(loadDoc('article.html'));
    expect(article).toBeDefined();
    expect(article?.passages).toHaveLength(21);
    expect(article?.passages.map((p) => p.index)).toEqual([...Array(21).keys()]);
    expect(article?.passages[0].el.id).toBe('p-abstract');
    expect(article?.passages.at(-1)?.el.id).toBe('p-boiler');
  });

  it('takes no passage from the bibliography, the nav, the figure, the footer or a hidden paragraph', () => {
    const passages = extractArticle(loadDoc('article.html'))?.passages ?? [];
    const texts = passages.map((p) => p.text).join('\n');
    expect(texts).not.toContain('Sparse attention for very long sequences');
    expect(texts).not.toContain('Browse by subject');
    expect(texts).not.toContain('Figure 1 shows the attention mass');
    expect(texts).not.toContain('Copyright 2026 the authors');
    expect(texts).not.toContain('hidden with the hidden attribute');
    expect(texts).not.toContain('hidden from assistive technology');
    expect(texts).not.toContain('display none');
  });

  it('derives ids from the passage text and stamps them on every passage', () => {
    const article = extractArticle(loadDoc('article.html'));
    const abstract = article?.passages[0];
    expect(abstract?.id).toBe(passageId(abstract?.text ?? ''));
    expect(abstract?.id).toMatch(/^rd:\d+$/);
    expect(new Set(article?.passages.map((p) => p.id)).size).toBe(21); // no two paragraphs collide
  });

  it('takes the title from the h1 and the lead from the first passage', () => {
    const doc = loadDoc('article.html');
    const article = extractArticle(doc);
    expect(article?.ctx.title).toBe('Attention Layers for Long Documents');
    expect(article?.ctx.lead).toBe(article?.passages[0].text);
    expect(article?.ctx.source).toBe(doc.URL);
  });
});

describe('extractArticle container descent', () => {
  it('keeps the common parent when comments hold a quarter of the text (a blog)', () => {
    // 140, not 120: 11 paragraphs must clear MIN_ARTICLE_CHARS (1500) in total or extractArticle
    // rejects the page before container descent is ever exercised; the 8:3 split (not the per-paragraph
    // size) is what keeps the <article> child under the 80% CONTAINER_SHARE threshold.
    const doc = parse(`
      <article>${paragraphs(8, 140, 'post')}</article>
      <section id="comments">${paragraphs(3, 140, 'comment')}</section>
    `);
    const article = extractArticle(doc);
    expect(article?.passages).toHaveLength(11);
    expect(article?.passages[8].text.startsWith('comment 0')).toBe(true);
  });

  it('descends into the one child that holds nearly all of the text', () => {
    const doc = parse(`
      <div id="shell">
        <div id="main">${paragraphs(10, 200, 'body')}</div>
        <div id="aside-ish"><p>${'z'.repeat(60)}</p></div>
      </div>
    `);
    const article = extractArticle(doc);
    expect(article?.passages).toHaveLength(10); // the 60-char sibling is outside #main and so outside the container
  });
});

describe('extractArticle rejections', () => {
  it('returns undefined for a docs page of four short paragraphs', () => {
    expect(extractArticle(parse(`
      <h1>Getting started</h1>
      <p>Install it with your package manager of choice today.</p>
      <p>Configuration lives in a single yaml file at the root.</p>
      <p>Run the binary with the config flag pointed at that file.</p>
      <p>Everything else is covered in the frequently asked questions.</p>
    `))).toBeUndefined();
  });

  it('returns undefined for an empty app shell', () => {
    expect(extractArticle(parse('<div id="root"></div>'))).toBeUndefined();
  });

  it('returns undefined when six paragraphs do not add up to 1500 characters', () => {
    expect(extractArticle(parse(paragraphs(6, 50)))).toBeUndefined();
  });

  it('accepts exactly six paragraphs once they clear 1500 characters', () => {
    expect(extractArticle(parse(paragraphs(6, 260)))?.passages).toHaveLength(6);
  });
});

describe('extractArticle context and caps', () => {
  it('prefers a meta description of 40 characters or more as the lead', () => {
    const description = 'A description long enough to be worth using as the document lead.';
    const doc = parse(paragraphs(8, 200), `<meta name="description" content="${description}" />`);
    expect(extractArticle(doc)?.ctx.lead).toBe(description);
  });

  it('falls back to the first passage when the meta description is too short', () => {
    const doc = parse(paragraphs(8, 200), '<meta name="description" content="Too short." />');
    const article = extractArticle(doc);
    expect(article?.ctx.lead).toBe(article?.passages[0].text);
  });

  it('falls back to document.title when the container has no h1, and truncates both caps', () => {
    const doc = parse(paragraphs(8, 900), `<title>${'T'.repeat(300)}</title>`);
    const article = extractArticle(doc);
    expect(article?.ctx.title).toHaveLength(200);
    expect(article?.ctx.lead).toHaveLength(600);
  });

  it('keeps the first 600 passages of a longer document', () => {
    const article = extractArticle(parse(paragraphs(700, 60)));
    expect(article?.passages).toHaveLength(600);
    expect(article?.passages.at(-1)?.text.startsWith('para 599')).toBe(true);
  });
});

describe('articleCandidates', () => {
  it('counts every qualifying paragraph, whatever the container decides', () => {
    expect(articleCandidates(loadDoc('article.html'))).toHaveLength(21);
    expect(articleCandidates(parse('<div id="root"></div>'))).toHaveLength(0);
    expect(articleCandidates(parse('<p>short</p><p>also short</p>'))).toHaveLength(0);
  });
});
