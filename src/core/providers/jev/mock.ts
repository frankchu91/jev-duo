import { fnv1a } from '../../hash';
import type { JevAnswer, JevProvider, JevRequest, JevResponse } from '../types';

export interface MockJevOptions {
  fixtures?: Record<string, Record<string, number>>;
  latencyMs?: number;
}

// Words too common to carry meaning for overlap scoring.
const STOPWORDS = new Set([
  'the', 'and', 'this', 'post', 'that', 'with', 'for', 'are', 'about', 'from', 'into',
  'best', 'described', 'any', 'anything', 'primarily', 'designed', 'is', 'an', 'or', 'of', 'to', 'a',
]);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

/** |a ∩ b| / max(1, |a|) — asymmetric so the denominator is always the "query" side. */
function overlapRatio(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  return hits / Math.max(1, a.size);
}

function stateTextOf(state: JevRequest['state']): string {
  return typeof state === 'string' ? state : JSON.stringify(state);
}

function answerNoul(id: string, statement: string, stateText: string): JevAnswer {
  const overlap = overlapRatio(tokens(statement), tokens(stateText));
  const jitter = ((fnv1a(id + stateText) % 1000) / 1000 - 0.5) * 0.06;
  const p = clamp(0.08 + 1.6 * overlap + jitter, 0.02, 0.98);
  return { id, type: 'noul', p };
}

function bestIndexByOverlap(candidates: string[], stateTokens: Set<string>): { overlaps: number[]; bestIndex: number } {
  const overlaps = candidates.map((c) => overlapRatio(tokens(c), stateTokens));
  let bestIndex = 0;
  for (let i = 1; i < overlaps.length; i++) if (overlaps[i] > overlaps[bestIndex]) bestIndex = i;
  return { overlaps, bestIndex };
}

function answerChoice(id: string, options: string[], stateText: string): JevAnswer {
  const { overlaps, bestIndex } = bestIndexByOverlap(options, tokens(stateText));
  const raw = overlaps.map((o) => o + 0.05);
  const sum = raw.reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  options.forEach((o, i) => { probabilities[o] = raw[i] / sum; });
  const confidence = Math.max(...Object.values(probabilities));
  return { id, type: 'choice', choice: options[bestIndex], probabilities, confidence };
}

function answerScore(id: string, levels: string[], stateText: string): JevAnswer {
  const { bestIndex } = bestIndexByOverlap(levels, tokens(stateText));
  const probabilities: Record<string, number> = {};
  levels.forEach((_, i) => { probabilities[String(i)] = i === bestIndex ? 1 : 0; });
  return { id, type: 'score', score: bestIndex, probabilities, confidence: 0.6 };
}

/** Deterministic, network-free Jev: answers are a token-overlap heuristic over `state`, no Math.random/Date.now. */
export function createMockJev(opts: MockJevOptions = {}): JevProvider {
  const fixtures = opts.fixtures ?? {};
  const latencyMs = opts.latencyMs ?? 5;
  return {
    name: 'mock',
    async evaluate(req: JevRequest): Promise<JevResponse> {
      await Promise.resolve();
      const stateText = stateTextOf(req.state);
      const itemFixtures = req.meta?.itemId ? fixtures[req.meta.itemId] : undefined;
      const answers = req.questions.map((q): JevAnswer => {
        if (q.type === 'noul' && itemFixtures && q.id in itemFixtures) {
          return { id: q.id, type: 'noul', p: itemFixtures[q.id] };
        }
        if (q.type === 'noul') return answerNoul(q.id, q.statement, stateText);
        if (q.type === 'choice') return answerChoice(q.id, q.options, stateText);
        return answerScore(q.id, q.levels, stateText);
      });
      return { answers, latencyMs };
    },
  };
}
