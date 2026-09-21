import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterJev } from '../../../src/core/providers/jev/openrouter';
import type { JevRequest } from '../../../src/core/providers/types';

const okRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const request: JevRequest = {
  state: { text: 'refund please' },
  questions: [{ id: 'refund', type: 'noul', statement: 'the user wants a refund' }],
};

// Shape from docs/superpowers/research/typesafe-api.md section 9 (OpenRouter response example).
const openRouterResponse = {
  id: 'gen-dec-1789738314-X5e5eKGQdvR9rblyX250',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: { refund: { type: 'noul', noul: 0.98 } },
  usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
};

describe('createOpenRouterJev', () => {
  it('(p) posts to the OpenRouter systemone endpoint with the OpenRouter headers and default model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(openRouterResponse));
    const jev = createOpenRouterJev({ apiKey: 'or-key', fetchImpl });
    expect(jev.name).toBe('openrouter');

    await jev.evaluate(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer or-key',
      'X-Title': 'jev-duo',
      'HTTP-Referer': 'https://github.com/frankchu91/jev-duo',
    });
    expect(JSON.parse(init.body as string).model).toBe('typesafe/jev-1.13');
  });

  it('(q) parses a response carrying id/provider/usage.cost', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(openRouterResponse));
    const jev = createOpenRouterJev({ apiKey: 'or-key', fetchImpl });
    const result = await jev.evaluate(request);
    expect(result.answers).toEqual([{ id: 'refund', type: 'noul', p: 0.98 }]);
    expect(result.usage).toEqual({ inputTokens: 275 });
  });

  it('(r) maps the OpenRouter error shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes({ error: { code: 401, message: 'User not found.' } }, 401));
    const jev = createOpenRouterJev({ apiKey: 'bad', fetchImpl });
    await expect(jev.evaluate(request)).rejects.toMatchObject({ status: 401, message: 'User not found.' });
  });
});
