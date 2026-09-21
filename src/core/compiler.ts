import { ID_MAX_CHARS } from './constants';
import { extractJson } from './json';
import { COMPILE_SYSTEM, compileUser } from './prompts';
import { LlmPackOutputSchema, parsePack, type LlmPackOutput } from './schema';
import { ProviderError, type LlmProvider } from './providers/types';
import type { Example, QuestionPack } from './types';

export interface CompileOptions {
  examples?: Example[];
  now?: () => Date;
}

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parses and validates one LLM reply; never throws — failures come back as `{ error }` so the caller can decide whether to retry. */
function parseReply(text: string): { data: LlmPackOutput } | { error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (e) {
    return { error: describeError(e) };
  }
  const result = LlmPackOutputSchema.safeParse(json);
  return result.success ? { data: result.data } : { error: describeError(result.error) };
}

/** Appends `-2`, `-3`, ... to ids already seen in `seen`, so ids stay unique across rules and keeps
 * combined. The base is truncated so the suffixed id still fits the schema's 40-character id limit —
 * an LLM that returns two 40-char ids that collide would otherwise produce a pack that fails
 * validation (and so a compile that fails) purely because of the suffix. */
function dedupeIds<T extends { id: string }>(items: T[], seen: Map<string, number>): T[] {
  return items.map((item) => {
    const count = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, count);
    if (count === 1) return item;
    const suffix = `-${count}`;
    return { ...item, id: `${item.id.slice(0, ID_MAX_CHARS - suffix.length)}${suffix}` };
  });
}

/** System 2: turns a plain-English intent (plus any past corrections) into a typed QuestionPack via the LLM, retrying once on invalid output. */
export async function compile(intent: string, llm: LlmProvider, opts: CompileOptions = {}): Promise<QuestionPack> {
  if (intent.trim().length === 0) throw new ProviderError('compile: empty intent');
  const examples = opts.examples ?? [];
  const now = opts.now ?? (() => new Date());
  const userPrompt = compileUser(intent, examples);

  let reply = parseReply(await llm.completeJson(COMPILE_SYSTEM, userPrompt));
  if ('error' in reply) {
    const retryPrompt = `${userPrompt}\n\nYour previous output was invalid: ${reply.error}. Return only a valid JSON object.`;
    reply = parseReply(await llm.completeJson(COMPILE_SYSTEM, retryPrompt));
    if ('error' in reply) throw new ProviderError(`compile: invalid pack from ${llm.name}`);
  }

  const { rules, keeps, notes } = reply.data;
  if (rules.length === 0 && keeps.length === 0) throw new ProviderError('compile: no rules produced');

  const seen = new Map<string, number>();
  const dedupedRules = dedupeIds(rules, seen);
  const dedupedKeeps = dedupeIds(keeps, seen);

  return parsePack({
    version: 1,
    intent,
    compiledAt: now().toISOString(),
    compiledBy: llm.name,
    rules: dedupedRules,
    keeps: dedupedKeeps,
    notes,
  });
}
