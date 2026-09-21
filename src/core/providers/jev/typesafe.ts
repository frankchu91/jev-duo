import { fetchJson } from '../http';
import type { JevAnswer, JevProvider, JevQuestion, JevRequest, JevResponse } from '../types';
import { ProviderError } from '../types';

export interface TypesafeJevOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export interface SystemOneProviderOptions {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

type WireQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, null> }
  | { type: 'score'; instructions: string; criteria: string[] };

type WireAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, unknown> };

interface SystemOneResponseWire {
  model: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toWireQuestions(questions: JevQuestion[]): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const q of questions) {
    if (q.type === 'noul') {
      out[q.id] = { type: 'noul', instructions: q.statement };
    } else if (q.type === 'choice') {
      if (q.options.length > 255) throw new ProviderError('choice: max 255 options');
      const criteria: Record<string, null> = {};
      for (const opt of q.options) criteria[opt] = null;
      out[q.id] = { type: 'choice', instructions: q.question, criteria };
    } else {
      if (q.levels.length < 2 || q.levels.length > 10) throw new ProviderError('score: 2..10 levels');
      out[q.id] = { type: 'score', instructions: q.question, criteria: q.levels };
    }
  }
  return out;
}

/** Ids missing from the wire `answers` map are omitted (the evaluator treats a missing rule as p = 0). */
function toJevAnswers(questions: JevQuestion[], wireAnswers: Record<string, WireAnswer>): JevAnswer[] {
  const answers: JevAnswer[] = [];
  for (const q of questions) {
    const a = wireAnswers[q.id];
    if (!a) continue;
    if (a.type === 'noul') answers.push({ id: q.id, type: 'noul', p: a.noul });
    else if (a.type === 'choice') answers.push({ id: q.id, type: 'choice', choice: a.choice, probabilities: a.probabilities ?? {}, confidence: a.confidence ?? 0 });
    else answers.push({ id: q.id, type: 'score', score: a.score, probabilities: a.probabilities ?? {}, confidence: a.confidence ?? 0 });
  }
  return answers;
}

/** POST {baseUrl}/v1/systemone with the TypeSafe SystemOne wire format; shared by the native and OpenRouter clients. */
export function createSystemOneProvider(opts: SystemOneProviderOptions): JevProvider {
  return {
    name: opts.name,
    async evaluate(req: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
      const questions = toWireQuestions(req.questions);
      const body = JSON.stringify({ model: opts.model, state: req.state, questions });
      const started = Date.now();
      const data = await fetchJson<SystemOneResponseWire>(
        `${opts.baseUrl}/v1/systemone`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers },
          body,
        },
        { timeoutMs: opts.timeoutMs, retries: opts.retries, fetchImpl: opts.fetchImpl, signal },
      );
      const latencyMs = Date.now() - started;
      const answers = toJevAnswers(req.questions, data.answers ?? {});
      const usage = data.usage ? { inputTokens: data.usage.input_tokens } : undefined;
      return { answers, latencyMs, usage };
    },
  };
}

const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';

/** Native TypeSafe client for the Jev "System One" decision model. */
export function createTypesafeJev(opts: TypesafeJevOptions): JevProvider {
  return createSystemOneProvider({
    name: 'typesafe',
    baseUrl: opts.baseUrl ?? TYPESAFE_BASE_URL,
    model: opts.model ?? DEFAULT_MODEL,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
}
