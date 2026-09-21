import { describe, it, expect } from 'vitest';
import { providerConfigFromEnv } from '../../../src/cli/providers';

describe('providerConfigFromEnv', () => {
  it('(a) explicit --provider/--llm win over env, and no key is required for mock', () => {
    const { config, usedMock } = providerConfigFromEnv(
      { OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key' },
      { provider: 'mock', llm: 'mock' },
    );
    expect(config.jev).toBe('mock');
    expect(config.llm).toBe('mock');
    expect(usedMock).toBe(false);
  });

  it('(b) OPENROUTER_API_KEY alone selects openrouter for both jev and llm', () => {
    const { config, usedMock } = providerConfigFromEnv({ OPENROUTER_API_KEY: 'or-key' }, {});
    expect(config.jev).toBe('openrouter');
    expect(config.llm).toBe('openrouter');
    expect(config.keys.openrouter).toBe('or-key');
    expect(usedMock).toBe(false);
  });

  it('(c) TYPESAFE_API_KEY alone (no ANTHROPIC_API_KEY) selects typesafe jev and mock llm', () => {
    const { config, usedMock } = providerConfigFromEnv({ TYPESAFE_API_KEY: 'ts-key' }, {});
    expect(config.jev).toBe('typesafe');
    expect(config.llm).toBe('mock');
    expect(config.keys.typesafe).toBe('ts-key');
    expect(usedMock).toBe(false);
  });

  it('(d) TYPESAFE_API_KEY + ANTHROPIC_API_KEY selects typesafe jev and anthropic llm', () => {
    const { config, usedMock } = providerConfigFromEnv(
      { TYPESAFE_API_KEY: 'ts-key', ANTHROPIC_API_KEY: 'an-key' },
      {},
    );
    expect(config.jev).toBe('typesafe');
    expect(config.llm).toBe('anthropic');
    expect(config.keys.anthropic).toBe('an-key');
    expect(usedMock).toBe(false);
  });

  it('(e) no keys and no flags falls back to mock/mock with usedMock:true', () => {
    const { config, usedMock } = providerConfigFromEnv({}, {});
    expect(config.jev).toBe('mock');
    expect(config.llm).toBe('mock');
    expect(usedMock).toBe(true);
  });

  it('(f) an explicit --provider alone still lets --llm auto-detect independently', () => {
    const { config, usedMock } = providerConfigFromEnv(
      { TYPESAFE_API_KEY: 'ts-key', ANTHROPIC_API_KEY: 'an-key' },
      { provider: 'mock' },
    );
    expect(config.jev).toBe('mock');
    expect(config.llm).toBe('anthropic');
    expect(usedMock).toBe(false);
  });

  it('(g) OPENROUTER_API_KEY takes priority over TYPESAFE_API_KEY when both are present', () => {
    const { config } = providerConfigFromEnv({ OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key' }, {});
    expect(config.jev).toBe('openrouter');
    expect(config.llm).toBe('openrouter');
  });

  it('always threads whatever keys are present into config.keys, regardless of the chosen mode', () => {
    const { config } = providerConfigFromEnv(
      { OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key', ANTHROPIC_API_KEY: 'an-key' },
      { provider: 'mock', llm: 'mock' },
    );
    expect(config.keys).toEqual({ openrouter: 'or-key', typesafe: 'ts-key', anthropic: 'an-key' });
  });
});
