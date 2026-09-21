import { describe, expect, it, vi } from 'vitest';
import { createTypesafeJev } from '../../../src/core/providers/jev/typesafe';
import type { JevRequest } from '../../../src/core/providers/types';

const okRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const request: JevRequest = {
  state: { text: 'hello' },
  questions: [
    { id: 'q1', type: 'noul', statement: 'is this urgent' },
    { id: 'q2', type: 'choice', question: 'which team', options: ['a', 'b'] },
    { id: 'q3', type: 'score', question: 'how bad', levels: ['low', 'mid', 'high'] },
  ],
};

// Verbatim from docs.typesafe.ai/introduction/quickstart (docs/superpowers/research/typesafe-api.md section 3),
// with the answers map's keys renamed to this file's q1/q2/q3 (is_urgent -> q1, department -> q2, frustration -> q3).
const quickstartResponse = {
  model: 'jev-1.13.0',
  answers: {
    q2: {
      type: 'choice',
      choice: 'technical',
      confidence: 0.78,
      probabilities: { technical: 0.85, sales: 0.0, billing: 0.15 },
    },
    q3: {
      type: 'score',
      score: 1.0,
      confidence: 1.0,
      legend: { '0': 'Calm, just stating facts', '1': 'Frustrated but civil', '2': 'Very angry, strong language' },
      probabilities: { '0': 0.0, '1': 1.0, '2': 0.0 },
    },
    q1: { type: 'noul', noul: 1.0 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
};

describe('createTypesafeJev', () => {
  it('(h) sends the exact wire request and maps the exact wire response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(quickstartResponse));
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    expect(jev.name).toBe('typesafe');

    const result = await jev.evaluate(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: { text: 'hello' },
      questions: {
        q1: { type: 'noul', instructions: 'is this urgent' },
        q2: { type: 'choice', instructions: 'which team', criteria: { a: null, b: null } },
        q3: { type: 'score', instructions: 'how bad', criteria: ['low', 'mid', 'high'] },
      },
    });

    expect(result.usage).toEqual({ inputTokens: 392 });
    expect(result.answers).toEqual([
      { id: 'q1', type: 'noul', p: 1.0 },
      { id: 'q2', type: 'choice', choice: 'technical', probabilities: { technical: 0.85, sales: 0.0, billing: 0.15 }, confidence: 0.78 },
      { id: 'q3', type: 'score', score: 1.0, probabilities: { '0': 0.0, '1': 1.0, '2': 0.0 }, confidence: 1.0 },
    ]);
  });

  it('(i) omits ids missing from the response', async () => {
    const partial = {
      ...quickstartResponse,
      answers: { q1: quickstartResponse.answers.q1, q3: quickstartResponse.answers.q3 },
    };
    const fetchImpl = vi.fn().mockResolvedValue(okRes(partial));
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    const result = await jev.evaluate(request);
    expect(result.answers).toHaveLength(2);
    expect(result.answers.map((a) => a.id)).toEqual(['q1', 'q3']);
  });

  it('(j) rejects a >255-option choice question before any fetch', async () => {
    const fetchImpl = vi.fn();
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    const bigChoice: JevRequest = {
      state: 's',
      questions: [{ id: 'c', type: 'choice', question: 'q', options: Array.from({ length: 256 }, (_, i) => `o${i}`) }],
    };
    await expect(jev.evaluate(bigChoice)).rejects.toThrow('choice: max 255 options');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('(k) rejects a 1-level score question before any fetch', async () => {
    const fetchImpl = vi.fn();
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    const oneLevel: JevRequest = { state: 's', questions: [{ id: 's1', type: 'score', question: 'q', levels: ['only'] }] };
    await expect(jev.evaluate(oneLevel)).rejects.toThrow('score: 2..10 levels');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('(l) maps a 401 authentication error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errRes(
        {
          detail: {
            error_type: 'authentication_error',
            message: 'Cannot authenticate with the server. Please check your API key and try again.',
          },
        },
        401,
      ),
    );
    const jev = createTypesafeJev({ apiKey: 'bad', fetchImpl });
    await expect(jev.evaluate(request)).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Cannot authenticate'),
    });
  });

  it('(m) maps a 422 validation error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(errRes({ detail: [{ loc: ['body', 'questions', 'q', 'criteria'], msg: 'field required' }] }, 422));
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    await expect(jev.evaluate(request)).rejects.toMatchObject({ message: expect.stringContaining('field required') });
  });

  it('(n) sends an explicit model verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(quickstartResponse));
    const jev = createTypesafeJev({ apiKey: 'k', model: 'jev-1.13.0', fetchImpl });
    await jev.evaluate(request);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string).model).toBe('jev-1.13.0');
  });

  it('(o) forwards the caller signal to fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(quickstartResponse));
    const jev = createTypesafeJev({ apiKey: 'k', fetchImpl });
    const controller = new AbortController();
    await jev.evaluate(request, controller.signal);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
