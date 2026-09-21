import { describe, expect, it, vi } from 'vitest';
import { createAnthropicLlm } from '../../../src/core/providers/llm/anthropic';
import { createOpenRouterLlm } from '../../../src/core/providers/llm/openrouter';

const okRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errRes = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Shape from the task-4 brief: a canned non-streaming Anthropic Messages response.
const anthropicOk = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: '{"a":1}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('createAnthropicLlm', () => {
  it('(a) posts to /v1/messages with the x-api-key header, default model, and returns the completion text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(anthropicOk));
    const llm = createAnthropicLlm({ apiKey: 'sk-ant-test', fetchImpl, maxRetries: 0 });
    expect(llm.name).toBe('anthropic');

    const result = await llm.completeJson('sys prompt', 'user prompt');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/v1\/messages$/);
    expect(init.method).toBe('POST');
    expect(init.headers.get('x-api-key')).toBe('sk-ant-test');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(8192);
    expect(body.system).toBe('sys prompt');
    expect(body.messages).toEqual([{ role: 'user', content: 'user prompt' }]);
    expect(body.thinking).toBeUndefined(); // Opus 5 thinks adaptively by default; never send `thinking`.

    expect(result).toBe('{"a":1}');
  });

  it('(b) sends an explicit model and maxTokens override verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(anthropicOk));
    const llm = createAnthropicLlm({ apiKey: 'k', model: 'claude-opus-5-custom', fetchImpl, maxRetries: 0 });
    await llm.completeJson('s', 'u', { maxTokens: 256 });
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-opus-5-custom');
    expect(body.max_tokens).toBe(256);
  });

  it('(c) rejects with /refused/ when stop_reason is refusal and content is empty', async () => {
    const refusal = { ...anthropicOk, content: [], stop_reason: 'refusal' };
    const fetchImpl = vi.fn().mockResolvedValue(okRes(refusal));
    const llm = createAnthropicLlm({ apiKey: 'k', fetchImpl, maxRetries: 0 });
    await expect(llm.completeJson('s', 'u')).rejects.toThrow(/refused/);
  });

  it('(d) rejects with "empty completion" when there is no text and no refusal', async () => {
    const empty = { ...anthropicOk, content: [], stop_reason: 'end_turn' };
    const fetchImpl = vi.fn().mockResolvedValue(okRes(empty));
    const llm = createAnthropicLlm({ apiKey: 'k', fetchImpl, maxRetries: 0 });
    await expect(llm.completeJson('s', 'u')).rejects.toThrow('empty completion');
  });

  it('(e) maps a 401 authentication error to a ProviderError with status 401', async () => {
    const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
    const fetchImpl = vi.fn().mockResolvedValue(errRes(body, 401));
    const llm = createAnthropicLlm({ apiKey: 'bad', fetchImpl, maxRetries: 0 });
    await expect(llm.completeJson('s', 'u')).rejects.toMatchObject({ status: 401 });
  });

  it('(f) maps browser: true to dangerouslyAllowBrowser', () => {
    // Node's own `navigator` global is a getter-only own property, so plain assignment
    // throws; vi.stubGlobal patches it (and restores it via unstubAllGlobals) safely.
    vi.stubGlobal('window', { document: {} });
    vi.stubGlobal('navigator', {});
    try {
      expect(() => createAnthropicLlm({ apiKey: 'k', fetchImpl: vi.fn(), maxRetries: 0 })).toThrow(
        /browser-like environment/,
      );
      expect(() =>
        createAnthropicLlm({ apiKey: 'k', fetchImpl: vi.fn(), maxRetries: 0, browser: true }),
      ).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('createOpenRouterLlm', () => {
  const okChat = (content: unknown) => okRes({ choices: [{ message: { content } }] });

  it('(g) posts to the chat completions endpoint with the OpenRouter headers, default model, and returns the content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChat('hello world'));
    const llm = createOpenRouterLlm({ apiKey: 'or-key', fetchImpl });
    expect(llm.name).toBe('openrouter');

    const result = await llm.completeJson('sys prompt', 'user prompt');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer or-key',
      'X-Title': 'jev-duo',
      'HTTP-Referer': 'https://github.com/frankchu91/jev-duo',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('anthropic/claude-opus-5');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
    expect(body.max_tokens).toBe(8192);

    expect(result).toBe('hello world');
  });

  it('(h) sends an explicit model override verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChat('hi'));
    const llm = createOpenRouterLlm({ apiKey: 'or-key', model: 'anthropic/claude-opus-5-custom', fetchImpl });
    await llm.completeJson('s', 'u');
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string).model).toBe('anthropic/claude-opus-5-custom');
  });

  it('(i) joins an array-of-parts message content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okChat([
        { type: 'text', text: 'foo' },
        { type: 'text', text: 'bar' },
      ]),
    );
    const llm = createOpenRouterLlm({ apiKey: 'or-key', fetchImpl });
    const result = await llm.completeJson('s', 'u');
    expect(result).toBe('foobar');
  });

  it('(j) rejects with "empty completion" when content is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChat(''));
    const llm = createOpenRouterLlm({ apiKey: 'or-key', fetchImpl });
    await expect(llm.completeJson('s', 'u')).rejects.toThrow('empty completion');
  });

  it('(k) maps a 401 error to a ProviderError with status 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes({ error: { code: 401, message: 'Unauthorized' } }, 401));
    const llm = createOpenRouterLlm({ apiKey: 'bad', fetchImpl });
    await expect(llm.completeJson('s', 'u')).rejects.toMatchObject({ status: 401 });
  });
});
