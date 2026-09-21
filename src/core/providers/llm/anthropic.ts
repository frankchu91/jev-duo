import Anthropic from '@anthropic-ai/sdk';
import type { LlmCompleteOptions, LlmProvider } from '../types';
import { ProviderError } from '../types';

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  browser?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Official @anthropic-ai/sdk client as the "slow brain" LLM provider. No `thinking` param
 * (Opus 5 runs adaptive thinking by default) and no assistant prefill.
 */
export function createAnthropicLlm(opts: AnthropicLlmOptions): LlmProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    fetch: opts.fetchImpl,
    dangerouslyAllowBrowser: opts.browser === true,
    maxRetries: opts.maxRetries ?? 2,
    timeout: opts.timeoutMs ?? 60_000,
  });
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    name: 'anthropic',
    async completeJson(system: string, user: string, callOpts: LlmCompleteOptions = {}): Promise<string> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: callOpts.maxTokens ?? DEFAULT_MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          },
          { signal: callOpts.signal },
        );
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          const status = err.status;
          throw new ProviderError(err.message, status, status === 429 || (status !== undefined && status >= 500));
        }
        throw err;
      }

      if (message.stop_reason === 'refusal') throw new ProviderError('llm refused the request');

      const parts: string[] = [];
      for (const block of message.content) if (block.type === 'text') parts.push(block.text);
      const text = parts.join('');
      if (!text) throw new ProviderError('empty completion');
      return text;
    },
  };
}
