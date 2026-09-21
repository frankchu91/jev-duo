import { z } from 'zod';
import { DEFAULT_AMBIGUOUS_LOW, DEFAULT_HIDE_THRESHOLD, DEFAULT_KEEP_THRESHOLD, LABEL_MAX_CHARS, STRICTNESS_MAX_THRESHOLD, STRICTNESS_MIN_THRESHOLD } from './constants';
import type { QuestionPack } from './types';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'id must be a lowercase slug');
const Label = z.string().min(1).transform((s) => s.trim().slice(0, LABEL_MAX_CHARS));
const Threshold = z.number().transform((n) => clamp(n, STRICTNESS_MIN_THRESHOLD, STRICTNESS_MAX_THRESHOLD));
const ActionSchema = z.enum(['fold', 'dim', 'badge']);

export const RuleSchema = z.object({
  id: Id, label: z.string().min(1).max(LABEL_MAX_CHARS), question: z.string().min(1),
  threshold: z.number().min(0).max(1), action: ActionSchema,
  ambiguous: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
});
export const KeepRuleSchema = z.object({ id: Id, label: z.string().min(1).max(LABEL_MAX_CHARS), question: z.string().min(1), threshold: z.number().min(0).max(1) });

const noDuplicateIds = <T extends { id: string }>(xs: T[], ctx: z.RefinementCtx, what: string) => {
  const seen = new Set<string>();
  for (const x of xs) { if (seen.has(x.id)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} id: ${x.id}` }); seen.add(x.id); }
};

export const QuestionPackSchema = z.object({
  version: z.literal(1), intent: z.string(), compiledAt: z.string(), compiledBy: z.string(),
  rules: z.array(RuleSchema), keeps: z.array(KeepRuleSchema), notes: z.string().optional(),
}).superRefine((p, ctx) => { noDuplicateIds(p.rules, ctx, 'rule'); noDuplicateIds(p.keeps, ctx, 'keep'); });

export function parsePack(input: unknown): QuestionPack { return QuestionPackSchema.parse(input) as QuestionPack; }

// What the LLM returns; defaults and normalisation applied here.
export const LlmPackOutputSchema = z.object({
  rules: z.array(z.object({
    id: Id, label: Label, question: z.string().min(1),
    threshold: Threshold.default(DEFAULT_HIDE_THRESHOLD), action: ActionSchema.default('fold'),
  })).transform((rs) => rs.map((r) => ({ ...r, ambiguous: [Math.min(DEFAULT_AMBIGUOUS_LOW, r.threshold), r.threshold] as [number, number] }))),
  keeps: z.array(z.object({ id: Id, label: Label, question: z.string().min(1), threshold: Threshold.default(DEFAULT_KEEP_THRESHOLD) })).default([]),
  notes: z.string().optional(),
});
export type LlmPackOutput = z.infer<typeof LlmPackOutputSchema>;
