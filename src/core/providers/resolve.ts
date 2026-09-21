import { createOpenRouterJev } from './jev/openrouter';
import { createTypesafeJev } from './jev/typesafe';
import { createMockJev } from './jev/mock';
import { createAnthropicLlm } from './llm/anthropic';
import { createOpenRouterLlm } from './llm/openrouter';
import { createMockLlm } from './llm/mock';
import type { JevProvider, LlmProvider } from './types';
import { ProviderError } from './types';

export type ProviderMode = 'mock' | 'openrouter' | 'typesafe';

export interface ProviderConfig {
  jev: ProviderMode;
  llm: 'mock' | 'openrouter' | 'anthropic';
  keys: { openrouter?: string; typesafe?: string; anthropic?: string };
  llmModel?: string;
  browser?: boolean;
  fetchImpl?: typeof fetch;
  mockFixtures?: Record<string, Record<string, number>>;
}

function requireKey(key: string | undefined, envVar: string): string {
  if (!key) throw new ProviderError(`missing key: ${envVar}`);
  return key;
}

function resolveJev(cfg: ProviderConfig): JevProvider {
  if (cfg.jev === 'mock') return createMockJev({ fixtures: cfg.mockFixtures });
  if (cfg.jev === 'openrouter') {
    return createOpenRouterJev({ apiKey: requireKey(cfg.keys.openrouter, 'OPENROUTER_API_KEY'), fetchImpl: cfg.fetchImpl });
  }
  return createTypesafeJev({ apiKey: requireKey(cfg.keys.typesafe, 'TYPESAFE_API_KEY'), fetchImpl: cfg.fetchImpl });
}

function resolveLlm(cfg: ProviderConfig): LlmProvider {
  if (cfg.llm === 'mock') return createMockLlm();
  if (cfg.llm === 'openrouter') {
    return createOpenRouterLlm({
      apiKey: requireKey(cfg.keys.openrouter, 'OPENROUTER_API_KEY'),
      model: cfg.llmModel,
      fetchImpl: cfg.fetchImpl,
    });
  }
  return createAnthropicLlm({
    apiKey: requireKey(cfg.keys.anthropic, 'ANTHROPIC_API_KEY'),
    model: cfg.llmModel,
    browser: cfg.browser,
    fetchImpl: cfg.fetchImpl,
  });
}

/** Builds the Jev and LLM providers named by `cfg`, throwing `ProviderError('missing key: <ENV_VAR>')` for any absent key. */
export function resolveProviders(cfg: ProviderConfig): { jev: JevProvider; llm: LlmProvider } {
  return { jev: resolveJev(cfg), llm: resolveLlm(cfg) };
}
