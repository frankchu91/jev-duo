import { LABEL_MAX_CHARS } from '../../constants';
import type { Action } from '../../types';
import { ProviderError, type LlmProvider } from '../types';

const VERB_RE = /^(hide|fold|remove|mute|skip|no|never show( me)?|dim|badge|flag|tag|keep|always show( me)?|show me|but keep|except)\b\s*/i;
const KEEP_VERBS = new Set(['keep', 'always show', 'always show me', 'show me', 'but keep', 'except']);
const BADGE_VERBS = new Set(['badge', 'flag', 'tag']);

interface SplitRule { id: string; label: string; question: string; action: Action }
interface SplitKeep { id: string; label: string; question: string }

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return /^[a-z0-9]/.test(slug) ? slug : `r${slug}`;
}

function actionFor(verb: string): Action {
  if (verb === 'dim') return 'dim';
  if (BADGE_VERBS.has(verb)) return 'badge';
  return 'fold';
}

// Split a clause list on commas/and/or; a comma immediately before "and"/"or" leaves that
// word glued to the next clause (", and " only consumes the comma+space), so strip it after.
function clausesOf(remainder: string): string[] {
  return remainder
    .split(/\s*,\s*|\s+and\s+|\s+or\s+/)
    .map((c) => c.replace(/^(?:and|or)\s+/i, '').trim())
    .filter((c) => c.length > 0);
}

function dedupeId(id: string, seen: Map<string, number>): string {
  const count = (seen.get(id) ?? 0) + 1;
  seen.set(id, count);
  return count === 1 ? id : `${id}-${count}`;
}

function labelOf(clause: string): string {
  return clause.split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, LABEL_MAX_CHARS);
}

/** Splits a plain-English intent into fold/dim/badge rule clauses and keep clauses. */
export function splitIntent(intent: string): { rules: SplitRule[]; keeps: SplitKeep[] } {
  const rules: SplitRule[] = [];
  const keeps: SplitKeep[] = [];
  const seen = new Map<string, number>();

  const sentences = intent.split(/[.;\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const sentence of sentences) {
    const m = sentence.match(VERB_RE);
    const verb = m ? m[1].toLowerCase().replace(/\s+/g, ' ').trim() : '';
    const remainder = m ? sentence.slice(m[0].length) : sentence;
    const isKeep = KEEP_VERBS.has(verb);
    const action = actionFor(verb);

    for (const clause of clausesOf(remainder)) {
      const id = dedupeId(slugify(clause), seen);
      const label = labelOf(clause);
      const question = `This post is best described as: ${clause}.`;
      if (isKeep) keeps.push({ id, label, question });
      else rules.push({ id, label, question, action });
    }
  }
  return { rules, keeps };
}

/** Deterministic, network-free LLM: compiles <intent> blocks via splitIntent and answers <arbiter> prompts with "no hide". */
export function createMockLlm(): LlmProvider {
  return {
    name: 'mock',
    async completeJson(_system: string, user: string): Promise<string> {
      if (user.includes('<arbiter>')) return JSON.stringify({ hide: false, why: 'mock arbiter' });
      const match = user.match(/<intent>([\s\S]*?)<\/intent>/);
      if (!match) throw new ProviderError('mock llm: no <intent> block');
      const { rules, keeps } = splitIntent(match[1].trim());
      return JSON.stringify({ rules, keeps, notes: 'mock compiler: split intent into clauses' });
    },
  };
}
