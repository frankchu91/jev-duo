import { RETRIES, TIMEOUT_MS } from '../constants';
import { ProviderError } from './types';

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([408, 429]);
const isRetryableStatus = (status: number) => status >= 500 || RETRYABLE_STATUSES.has(status);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const timeoutError = (ms: number) => Object.assign(new Error(`timeout after ${ms}ms`), { name: 'TimeoutError' });

/** JSON when the body parses, else the raw text. Never throws on a malformed body. */
async function tolerantParse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text.length ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

const fieldStr = (v: unknown, field: string): string | undefined =>
  v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>)[field] === 'string'
    ? ((v as Record<string, unknown>)[field] as string)
    : undefined;

/** detail.message -> detail string -> detail[].msg joined -> error.message -> error string -> message -> raw text -> HTTP <status>. */
function errorMessage(status: number, body: unknown): string {
  const obj = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const detail = obj?.detail;
  const detailMsgs = Array.isArray(detail) ? detail.map((d) => fieldStr(d, 'msg')).filter((m): m is string => !!m) : [];
  return (
    fieldStr(detail, 'message') ??
    (typeof detail === 'string' ? detail : undefined) ??
    (detailMsgs.length ? detailMsgs.join('; ') : undefined) ??
    fieldStr(obj?.error, 'message') ??
    (typeof obj?.error === 'string' ? obj.error : undefined) ??
    (typeof obj?.message === 'string' ? obj.message : undefined) ??
    (typeof body === 'string' && body.trim() ? body : undefined) ??
    `HTTP ${status}`
  );
}

function retryDelayMs(attempt: number, headers?: Headers): number {
  const afterMs = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(afterMs) && afterMs > 0) return Math.min(10_000, afterMs);
  const afterSec = Number(headers?.get('retry-after'));
  if (Number.isFinite(afterSec) && afterSec > 0) return Math.min(10_000, afterSec * 1000);
  const jitter = (attempt * 37 + 11) % 101; // deterministic 0..100ms, derived from the attempt number (not Math.random)
  return 300 * 2 ** attempt + jitter;
}

/** One fetch, raced against a timeout that fires even if fetchImpl ignores the abort signal (as test doubles do). */
async function attemptFetch(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch, outerSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort);
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });
  const req = fetchImpl(url, { ...init, signal: controller.signal });
  req.catch(() => {}); // swallow a late rejection from the losing side of the race (no unhandled-rejection noise)
  try {
    return await Promise.race([req, timedOut]);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = TIMEOUT_MS, retries = RETRIES, signal, fetchImpl = fetch, sleep = defaultSleep } = opts;
  if (signal?.aborted) throw abortError();

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await attemptFetch(url, init, timeoutMs, fetchImpl, signal);
      if (res.ok) return (await tolerantParse(res)) as T;
      const body = await tolerantParse(res);
      const retryable = isRetryableStatus(res.status);
      if (!retryable || attempt >= retries) throw new ProviderError(errorMessage(res.status, body), res.status, retryable);
      await sleep(retryDelayMs(attempt, res.headers));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (signal?.aborted) throw abortError();
      if (attempt >= retries) throw new ProviderError(err instanceof Error ? err.message : String(err), undefined, true);
      await sleep(retryDelayMs(attempt));
    }
  }
}
