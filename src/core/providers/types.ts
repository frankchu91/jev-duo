export type JevQuestion =
  | { id: string; type: 'noul'; statement: string }
  | { id: string; type: 'choice'; question: string; options: string[] }
  | { id: string; type: 'score'; question: string; levels: string[] }; // 2..10 level descriptions, ordered low -> high; the answer's score is a (fractional) level index

export interface JevRequest {
  state: Record<string, unknown> | string;
  questions: JevQuestion[];
  meta?: { itemId?: string };
}

export type JevAnswer =
  | { id: string; type: 'noul'; p: number }
  | { id: string; type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { id: string; type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export interface JevResponse {
  answers: JevAnswer[];
  latencyMs: number;
  usage?: { inputTokens?: number };
}

export interface JevProvider {
  readonly name: string;
  evaluate(req: JevRequest, signal?: AbortSignal): Promise<JevResponse>;
}

export interface LlmCompleteOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: string;
  completeJson(system: string, user: string, opts?: LlmCompleteOptions): Promise<string>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}
