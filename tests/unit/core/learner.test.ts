import { describe, it, expect } from 'vitest';
import { ExampleStore } from '../../../src/core/learner';
import type { Example } from '../../../src/core/types';

function mkExample(id: string, source: Example['source'] = 'user'): Example {
  return {
    item: { id, platform: 'x', text: `post ${id}` },
    expected: 'hide',
    actualDecision: { kind: 'keep' },
    source,
    at: '2026-09-20T00:00:00.000Z',
  };
}

describe('ExampleStore', () => {
  it('is a ring buffer that drops the oldest example once beyond max', () => {
    const store = new ExampleStore(3, 10);
    store.add(mkExample('1'));
    store.add(mkExample('2'));
    store.add(mkExample('3'));
    store.add(mkExample('4'));
    expect(store.size).toBe(3);
    expect(store.list().map((e) => e.item.id)).toEqual(['2', '3', '4']);
  });

  it('list() returns oldest -> newest and a defensive copy', () => {
    const store = new ExampleStore(10, 10);
    store.add(mkExample('1'));
    store.add(mkExample('2'));
    const list = store.list();
    expect(list.map((e) => e.item.id)).toEqual(['1', '2']);
    list.push(mkExample('mutated'));
    expect(store.size).toBe(2); // mutating the returned array must not affect the store
  });

  it('userCount counts only source: user examples', () => {
    const store = new ExampleStore(10, 10);
    store.add(mkExample('1', 'user'));
    store.add(mkExample('2', 'arbiter'));
    store.add(mkExample('3', 'user'));
    expect(store.size).toBe(3);
    expect(store.userCount).toBe(2);
  });

  it('shouldAutoRecompile() is true after autoEvery user examples, ignoring arbiter examples, and false after markRecompiled()', () => {
    const store = new ExampleStore(50, 3);
    store.add(mkExample('1', 'user'));
    store.add(mkExample('2', 'arbiter'));
    store.add(mkExample('3', 'arbiter'));
    expect(store.sinceRecompile).toBe(1);
    expect(store.shouldAutoRecompile()).toBe(false);

    store.add(mkExample('4', 'user'));
    store.add(mkExample('5', 'user'));
    expect(store.sinceRecompile).toBe(3);
    expect(store.shouldAutoRecompile()).toBe(true);

    store.markRecompiled();
    expect(store.sinceRecompile).toBe(0);
    expect(store.shouldAutoRecompile()).toBe(false);
  });

  it('fromJSON(toJSON()) round-trips examples and sinceRecompile', () => {
    const store = new ExampleStore(10, 5);
    store.add(mkExample('1', 'user'));
    store.add(mkExample('2', 'arbiter'));
    store.add(mkExample('3', 'user'));

    const restored = ExampleStore.fromJSON(store.toJSON(), 10, 5);
    expect(restored.list()).toEqual(store.list());
    expect(restored.sinceRecompile).toBe(store.sinceRecompile);
    expect(restored.size).toBe(store.size);
    expect(restored.userCount).toBe(store.userCount);
  });

  it('fromJSON tolerates garbage input and returns an empty store instead of throwing', () => {
    expect(() => ExampleStore.fromJSON('nonsense')).not.toThrow();
    expect(ExampleStore.fromJSON('nonsense').size).toBe(0);
    expect(ExampleStore.fromJSON(null).size).toBe(0);
    expect(ExampleStore.fromJSON(undefined).size).toBe(0);
    expect(ExampleStore.fromJSON(42).size).toBe(0);
    expect(ExampleStore.fromJSON([1, 2, 3]).size).toBe(0);
    expect(ExampleStore.fromJSON({ examples: 'not an array' }).size).toBe(0);
    expect(ExampleStore.fromJSON({ examples: [1, 2, { foo: 'bar' }] }).size).toBe(0);
    expect(ExampleStore.fromJSON({ examples: [], sinceRecompile: 'nope' }).sinceRecompile).toBe(0);
  });

  it('defaults to max 200 and autoEvery 10 when constructed with no arguments', () => {
    const store = new ExampleStore();
    for (let i = 0; i < 201; i += 1) store.add(mkExample(`a${i}`, 'arbiter'));
    expect(store.size).toBe(200);

    for (let i = 0; i < 9; i += 1) store.add(mkExample(`u${i}`, 'user'));
    expect(store.shouldAutoRecompile()).toBe(false);
    store.add(mkExample('u9', 'user'));
    expect(store.shouldAutoRecompile()).toBe(true);
  });
});
