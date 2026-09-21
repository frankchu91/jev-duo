import { fetchJson } from '../http';
import type { LlmCompleteOptions, LlmProvider } from '../types';
import { ProviderError } from '../types';

export interface OpenRouterLlmOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type ContentPart = { text?: string };
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | ContentPart[] } }>;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-opus-5';

function textOf(content: string | ContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

/** OpenRouter's chat-completions endpoint as the "slow brain" LLM provider. */
export function createOpenRouterLlm(opts: OpenRouterLlmOptions): LlmProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    name: 'openrouter',
    async completeJson(system: string, user: string, callOpts: LlmCompleteOptions = {}): Promise<string> {
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: callOpts.maxTokens ?? 8192,
      });
      const data = await fetchJson<ChatCompletionResponse>(
        OPENROUTER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'HTTP-Referer': 'https://github.com/frankchu91/jev-duo',
            'X-Title': 'jev-duo',
            'Content-Type': 'application/json',
          },
          body,
        },
        { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, signal: callOpts.signal },
      );
      const text = textOf(data.choices?.[0]?.message?.content);
      if (!text) throw new ProviderError('empty completion');
      return text;
    },
  };
}
