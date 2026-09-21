import type { ProviderConfig, ProviderMode } from '../core/index.js';

/** Validates an explicit `--provider` value against the allow-list, so a typo (e.g. `--provider
 * oops`) is rejected with a clear message instead of silently falling through `resolveProviders`'s
 * own `if/else` chain (which treats any unrecognised string as `typesafe`). */
function checkProviderMode(value: string | undefined): ProviderMode | undefined {
  if (value === undefined) return undefined;
  if (value !== 'mock' && value !== 'openrouter' && value !== 'typesafe') {
    throw new Error(`unknown --provider "${value}" (expected mock, openrouter or typesafe)`);
  }
  return value;
}

function checkLlmMode(value: string | undefined): ProviderConfig['llm'] | undefined {
  if (value === undefined) return undefined;
  if (value !== 'mock' && value !== 'openrouter' && value !== 'anthropic') {
    throw new Error(`unknown --llm "${value}" (expected mock, openrouter or anthropic)`);
  }
  return value;
}

/** Resolves the Jev/LLM provider pair from explicit CLI flags first, falling back to whichever API
 * keys are present in the environment, and finally to mock/mock when nothing is configured. Jev and
 * llm are resolved independently, so e.g. `--provider mock` alone still lets `--llm` auto-detect. */
export function providerConfigFromEnv(
  env: NodeJS.ProcessEnv,
  flags: { provider?: string; llm?: string },
): { config: ProviderConfig; usedMock: boolean } {
  const explicitJev = checkProviderMode(flags.provider);
  const explicitLlm = checkLlmMode(flags.llm);

  const hasOpenrouter = !!env.OPENROUTER_API_KEY;
  const hasTypesafe = !!env.TYPESAFE_API_KEY;
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;

  const jev: ProviderMode = explicitJev ?? (hasOpenrouter ? 'openrouter' : hasTypesafe ? 'typesafe' : 'mock');

  const llm: ProviderConfig['llm'] =
    explicitLlm ?? (hasOpenrouter ? 'openrouter' : hasTypesafe ? (hasAnthropic ? 'anthropic' : 'mock') : 'mock');

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
