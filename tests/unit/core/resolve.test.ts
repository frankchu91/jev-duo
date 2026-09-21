import { describe, expect, it, vi } from 'vitest';
import { resolveProviders } from '../../../src/core/providers/resolve';
import type { JevRequest } from '../../../src/core/providers/types';

describe('resolveProviders', () => {
  it('(a) jev: mock, llm: mock needs no keys', () => {
    const { jev, llm } = resolveProviders({ jev: 'mock', llm: 'mock', keys: {} });
    expect(jev.name).toBe('mock');
    expect(llm.name).toBe('mock');
  });

  it('(b) jev: openrouter with no key throws naming OPENROUTER_API_KEY', () => {
    expect(() => resolveProviders({ jev: 'openrouter', llm: 'mock', keys: {} })).toThrow(/OPENROUTER_API_KEY/);
  });

  it('(c) jev: typesafe with no key throws naming TYPESAFE_API_KEY', () => {
    expect(() => resolveProviders({ jev: 'typesafe', llm: 'mock', keys: {} })).toThrow(/TYPESAFE_API_KEY/);
  });

  it('(d) llm: anthropic with no key throws naming ANTHROPIC_API_KEY', () => {
    expect(() => resolveProviders({ jev: 'mock', llm: 'anthropic', keys: {} })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('(e) jev: typesafe, llm: anthropic with keys resolves both', () => {
    const { jev, llm } = resolveProviders({
      jev: 'typesafe',
      llm: 'anthropic',
      keys: { typesafe: 'ts-key', anthropic: 'an-key' },
    });
    expect(jev.name).toBe('typesafe');
    expect(llm.name).toBe('anthropic');
  });

  it('(f) llm: openrouter reuses keys.openrouter and threads fetchImpl through to the provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { llm } = resolveProviders({ jev: 'mock', llm: 'openrouter', keys: { openrouter: 'or-key' }, fetchImpl });
    expect(llm.name).toBe('openrouter');

    await llm.completeJson('s', 'u');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer or-key' });
  });

  it('(g) mockFixtures flow into the mock Jev', async () => {
    const { jev } = resolveProviders({
      jev: 'mock',
      llm: 'mock',
      keys: {},
      mockFixtures: { item1: { q1: 0.91 } },
    });
    const request: JevRequest = {
      state: 'irrelevant text',
      questions: [{ id: 'q1', type: 'noul', statement: 'anything' }],
      meta: { itemId: 'item1' },
    };
    const result = await jev.evaluate(request);
    expect(result.answers).toEqual([{ id: 'q1', type: 'noul', p: 0.91 }]);
  });
});
