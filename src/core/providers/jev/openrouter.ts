import type { JevProvider } from '../types';
import { createSystemOneProvider } from './typesafe';

export interface OpenRouterJevOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
const DEFAULT_MODEL = 'typesafe/jev-1.13';

/** OpenRouter's Decisions API accepts the TypeSafe SystemOne body verbatim. */
export function createOpenRouterJev(opts: OpenRouterJevOptions): JevProvider {
  return createSystemOneProvider({
    name: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: opts.model ?? DEFAULT_MODEL,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': 'https://github.com/frankchu91/jev-duo',
      'X-Title': 'jev-duo',
    },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
}
