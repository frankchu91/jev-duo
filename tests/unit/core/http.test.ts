import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../../../src/core/providers/http';

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const textRes = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });

describe('fetchJson', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) parses a 200 JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ hello: 'world' }));
    const result = await fetchJson('https://x.test/a', {}, { fetchImpl });
    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('(b) retries once on 429 then resolves with the 200 result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'slow down' }, 429))
      .mockResolvedValueOnce(jsonRes({ ok: true }, 200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await fetchJson('https://x.test/b', {}, { fetchImpl, sleep });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(300);
  });

  it('(c) exhausts retries on repeated 503 text/plain and rejects with a retryable ProviderError', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textRes('no healthy upstream', 503)));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchJson('https://x.test/c', {}, { retries: 2, fetchImpl, sleep })).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('(d) does not retry a non-retryable 401 and rejects on the first attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ detail: { message: 'nope' } }, 401));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchJson('https://x.test/d', {}, { fetchImpl, sleep })).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('(e) rejects with a timeout error when the request never settles', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const promise = fetchJson('https://x.test/e', {}, { timeoutMs: 50, retries: 0, fetchImpl });
    const assertion = expect(promise).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('(f) rejects immediately with AbortError for an already-aborted signal, without calling fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(fetchJson('https://x.test/f', {}, { signal: controller.signal, fetchImpl })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('(g) honours a retry-after-ms header on a retryable response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'slow down' }, 429, { 'retry-after-ms': '1200' }))
      .mockResolvedValueOnce(jsonRes({ ok: true }, 200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await fetchJson('https://x.test/g', {}, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(1200);
  });
});
