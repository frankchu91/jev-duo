import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../../../src/core/constants';
import { buildState, packQuestions } from '../../../src/core/state';
import type { Item, QuestionPack } from '../../../src/core/types';

describe('buildState', () => {
  it('includes author and meta flags verbatim when present', () => {
    const item: Item = {
      id: 'x:1',
      platform: 'x',
      author: '@someone',
      text: 'hello world',
      meta: { hasLink: true, hasMedia: true, isReply: true, isPromoted: true },
    };
    expect(buildState(item)).toEqual({
      platform: 'x',
      author: '@someone',
      text: 'hello world',
      hasLink: true,
      hasMedia: true,
      isReply: true,
      isPromoted: true,
    });
  });

  it('omits author when absent and defaults every flag to false when meta is absent', () => {
    const item: Item = { id: 'hn:1', platform: 'hn', text: 'no meta here' };
    const state = buildState(item);
    expect(state).not.toHaveProperty('author');
    expect(state).toEqual({
      platform: 'hn',
      text: 'no meta here',
      hasLink: false,
      hasMedia: false,
      isReply: false,
      isPromoted: false,
    });
  });

  it('defaults individually-missing meta flags to false while keeping the ones that are set', () => {
    const item: Item = { id: 'r:1', platform: 'reddit', text: 'partial meta', meta: { hasLink: true } };
    expect(buildState(item)).toMatchObject({ hasLink: true, hasMedia: false, isReply: false, isPromoted: false });
  });

  it(`truncates text longer than MAX_TEXT_CHARS (${MAX_TEXT_CHARS}) and leaves shorter text untouched`, () => {
    const longText = 'a'.repeat(MAX_TEXT_CHARS + 500);
    const long = buildState({ id: 'r:2', platform: 'reddit', text: longText }) as { text: string };
    expect(long.text).toHaveLength(MAX_TEXT_CHARS);
    expect(long.text).toBe('a'.repeat(MAX_TEXT_CHARS));

    const short = buildState({ id: 'r:3', platform: 'reddit', text: 'short' }) as { text: string };
    expect(short.text).toBe('short');
  });
});

describe('packQuestions', () => {
  const pack: QuestionPack = {
    version: 1,
    intent: 'hide rage and promo, keep rust',
    compiledAt: 't',
    compiledBy: 'mock',
    rules: [
      { id: 'rage', label: 'Rage', question: 'This post is ragebait.', threshold: 0.7, action: 'fold', ambiguous: [0.45, 0.7] },
      { id: 'promo', label: 'Promo', question: 'This post is a promo.', threshold: 0.7, action: 'dim', ambiguous: [0.45, 0.7] },
    ],
    keeps: [{ id: 'rust', label: 'Rust', question: 'This post is about Rust.', threshold: 0.6 }],
  };

  it('emits rules first as r_<id> noul questions, then keeps as k_<id> noul questions', () => {
    expect(packQuestions(pack)).toEqual([
      { id: 'r_rage', type: 'noul', statement: 'This post is ragebait.' },
      { id: 'r_promo', type: 'noul', statement: 'This post is a promo.' },
      { id: 'k_rust', type: 'noul', statement: 'This post is about Rust.' },
    ]);
  });

  it('returns an empty array for a pack with no rules or keeps', () => {
    expect(packQuestions({ ...pack, rules: [], keeps: [] })).toEqual([]);
  });
});
