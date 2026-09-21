import type { ProviderConfig, ProviderMode } from '../core/index.js';

/** Resolves the Jev/LLM provider pair from explicit CLI flags first, falling back to whichever API
 * keys are present in the environment, and finally to mock/mock when nothing is configured. Jev and
 * llm are resolved independently, so e.g. `--provider mock` alone still lets `--llm` auto-detect. */
export function providerConfigFromEnv(
  env: NodeJS.ProcessEnv,
  flags: { provider?: string; llm?: string },
): { config: ProviderConfig; usedMock: boolean } {
  const hasOpenrouter = !!env.OPENROUTER_API_KEY;
  const hasTypesafe = !!env.TYPESAFE_API_KEY;
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;

  const jev: ProviderMode =
    (flags.provider as ProviderMode | undefined) ??
    (hasOpenrouter ? 'openrouter' : hasTypesafe ? 'typesafe' : 'mock');

  const llm: ProviderConfig['llm'] =
    (flags.llm as ProviderConfig['llm'] | undefined) ??
    (hasOpenrouter ? 'openrouter' : hasTypesafe ? (hasAnthropic ? 'anthropic' : 'mock') : 'mock');

  const usedMock = !flags.provider && !flags.llm && !hasOpenrouter && !hasTypesafe;

  return {
    config: {
      jev,
      llm,
      keys: { openrouter: env.OPENROUTER_API_KEY, typesafe: env.TYPESAFE_API_KEY, anthropic: env.ANTHROPIC_API_KEY },
    },
    usedMock,
  };
}
