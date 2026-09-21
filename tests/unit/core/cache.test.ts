import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LruCache, verdictKey } from '../../../src/core/cache';
import type { Item, QuestionPack } from '../../../src/core/types';

function mkPack(compiledAt: string): QuestionPack {
  return { version: 1, intent: 'x', compiledAt, compiledBy: 'mock', rules: [], keeps: [] };
}

describe('LruCache', () => {
  it('stores and retrieves values; has() and size reflect what is cached', () => {
    const cache = new LruCache<number>(3);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('b')).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once beyond max', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C'); // over capacity -> evicts 'a' (never touched since insertion)
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBe('B');
    expect(cache.get('c')).toBe('C');
  });

  it('get() promotes an entry to most-recently-used so it survives the next eviction', () => {
    const cache = new LruCache<string>(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a'); // touch 'a' -> 'b' is now the least-recently-used
    cache.set('c', 'C'); // evicts 'b', not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('entries() lists every [key, value] pair currently cached', () => {
    const cache = new LruCache<number>(5);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.entries()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('overwriting an existing key updates its value without growing size', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });
});

describe('verdictKey', () => {
  it('is the lowercase sha256 hex of `compiledAt|itemId|text`', async () => {
    const pack = mkPack('2026-09-20T00:00:00.000Z');
    const item: Item = { id: 'x:1', platform: 'x', text: 'hello world' };
    const expected = createHash('sha256').update('2026-09-20T00:00:00.000Z|x:1|hello world').digest('hex');
    expect(await verdictKey(pack, item)).toBe(expected);
    expect(await verdictKey(pack, item)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same pack and item', async () => {
    const pack = mkPack('t');
    const item: Item = { id: 'a', platform: 'generic', text: 'same' };
    expect(await verdictKey(pack, item)).toBe(await verdictKey(pack, item));
  });

  it('changes when compiledAt, item id, or item text differ', async () => {
    const base = await verdictKey(mkPack('t1'), { id: 'a', platform: 'generic', text: 'same' });
    const diffCompiledAt = await verdictKey(mkPack('t2'), { id: 'a', platform: 'generic', text: 'same' });
    const diffId = await verdictKey(mkPack('t1'), { id: 'b', platform: 'generic', text: 'same' });
    const diffText = await verdictKey(mkPack('t1'), { id: 'a', platform: 'generic', text: 'different' });
    expect(diffCompiledAt).not.toBe(base);
    expect(diffId).not.toBe(base);
    expect(diffText).not.toBe(base);
  });
});
