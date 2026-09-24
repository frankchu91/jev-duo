// Reading mode's fast-brain contract (design addendum 2026-09-22 §3/§4): what a passage is, what Jev
// is asked about one, and how the answers become highlight/dim/plain. Pure and DOM-free — the HTML
// extractor (src/extension/reading/article.ts), the PDF extractor (pdf-text.ts) and the reader UI all
// speak these types, and nothing here knows which of the two produced a passage.
//
// This is deliberately NOT a QuestionPack: there is no compiler, no strictness slider and no arbiter
// in reading mode (spec §13). The three questions are a fixed template with the user's focus inlined,
// which is what makes a TypeSafe-only setup (no LLM key at all) work.

import { fnv1a } from './hash';
import type { JevAnswer, JevQuestion } from './providers/types';

export interface Passage {
  id: string;
  index: number;
  /** Document order position, assigned by whoever extracted the passage. */
  text: string;
  /** 1-based page number; PDFs have one, HTML pages do not. */
  page?: number;
}

export interface DocContext {
  title: string;
  lead: string;
  /** The page URL, the PDF URL, or the picked file's name. */
  source: string;
}

export const MIN_PASSAGE_CHARS = 40;
export const MAX_PASSAGES = 600;
export const JUDGE_TEXT_MAX = 1500;
export const TITLE_MAX = 200;
export const LEAD_MAX = 600;

/** `rd:<fnv1a(first 300 chars)>` (§3). Stable across reloads and identical for two passages with the
 * same opening, which is what lets a mock fixture — and the judge's cache — be keyed by text alone. */
export function passageId(text: string): string {
  return `rd:${fnv1a(text.slice(0, 300))}`;
}

export const CORE_STATEMENT =
  "The passage states a substantive claim, method, finding, or explanation that carries the document's own content, rather than background, related work, acknowledgments, boilerplate, references, navigation, or filler.";

/** Addendum 2026-09-23 §2.1. `core` cannot select on an article: measured with the real provider on an
 * eleven-paragraph news piece, every paragraph scored 0.86–0.94, because on an article almost every
 * paragraph really does carry the document's own content. Salience is a different question, so it is
 * asked as one — and it is this answer the ranking below sorts on. */
export const KEY_STATEMENT =
  'This passage is one of the few a reader skimming the document for its essentials must not miss — a central claim, a key result or number, a decisive quotation, or the conclusion — rather than a supporting, connective, or illustrative passage.';

export const KIND_OPTIONS = ['claim', 'method', 'result', 'background', 'boilerplate'];

/** The per-passage question list (§4.1, addendum §2.1), in order: core, key, then focus only when one
 * is set, then kind. */
export function readingQuestions(focus: string): JevQuestion[] {
  const trimmed = focus.trim();
  const questions: JevQuestion[] = [
    { id: 'core', type: 'noul', statement: CORE_STATEMENT },
    { id: 'key', type: 'noul', statement: KEY_STATEMENT },
  ];
  if (trimmed !== '') {
    questions.push({
      id: 'focus',
      type: 'noul',
      statement: `The passage contains information that directly addresses the reader's question: "${trimmed}".`,
    });
  }
  questions.push({ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS });
  return questions;
}

/** Everything Jev is told about one passage (§4.1) — the passage plus just enough of the document to
 * make "does this carry the document's own content?" answerable. Nothing else is ever sent (§11). */
export function readingState(ctx: DocContext, passage: Passage): Record<string, unknown> {
  return { document_title: ctx.title, document_lead: ctx.lead, passage: passage.text.slice(0, JUDGE_TEXT_MAX) };
}

export type ReadingVerdictKind = 'highlight' | 'dim' | 'plain';

export interface ReadingVerdict {
  id: string;
  verdict: ReadingVerdictKind;
  /** The probability the decision was made on: after `rankReading`, the ranking score for a highlight
   * and `core` for a dim or a plain passage. */
  p: number;
  core: number;
  /** Addendum §2.1's salience answer, 0.5 when the provider did not answer it. Required, because the
   * ranking sorts every verdict on it and must never have to ask whether it is there. */
  key: number;
  focus?: number;
  kind?: string;
  error?: true;
}

export const T_HIGHLIGHT_CORE = 0.7;
export const T_HIGHLIGHT_FOCUS = 0.6;
export const T_DIM = 0.3;

/** §4.2, and now PROVISIONAL only: the verdict one passage's answers imply on their own, before the
 * document it belongs to has been ranked (addendum §2.3 — nothing downstream shows this any more,
 * `rankReading` reassigns every one of them). Fixed thresholds: the strictness slider is a feed-mode
 * control and deliberately does not apply here (§13). A passage with no `core` (or no `key`) answer is
 * treated as 0.5 — squarely plain — so a malformed reply shows the passage as the page rendered it
 * rather than dimming it. */
export function decideReading(id: string, answers: JevAnswer[], hasFocus: boolean): ReadingVerdict {
  let core = 0.5;
  let key = 0.5;
  let focus: number | undefined;
  let kind: string | undefined;
  for (const a of answers) {
    if (a.type === 'noul' && a.id === 'core') core = a.p;
    else if (a.type === 'noul' && a.id === 'key') key = a.p;
    else if (a.type === 'noul' && a.id === 'focus') focus = a.p;
    else if (a.type === 'choice' && a.id === 'kind') kind = a.choice;
  }

  // With a focus set but no focus answer (a provider that dropped a question), `core` stands in for it
  // rather than the passage silently defaulting to 0.
  const decisive = hasFocus ? focus ?? core : core;
  const highlight = hasFocus ? decisive >= T_HIGHLIGHT_FOCUS : core >= T_HIGHLIGHT_CORE;
  // The focus guard is why a half-relevant passage is never dimmed: you asked about it.
  const dim = core <= T_DIM && (!hasFocus || decisive <= T_DIM);

  const out: ReadingVerdict = { id, verdict: highlight ? 'highlight' : dim ? 'dim' : 'plain', p: decisive, core, key };
  if (focus !== undefined) out.focus = focus;
  if (kind !== undefined) out.kind = kind;
  return out;
}

/** Addendum §2.2. Of the judged passages, rounded up, at least one. */
export const HIGHLIGHT_SHARE = 0.25;
/** Of the judged passages, rounded down — the least substantive fifth, or none at all in a short one. */
export const DIM_SHARE = 0.2;
/** A passage below this on its ranking score is never highlighted, however thin the competition. */
export const HIGHLIGHT_FLOOR = 0.5;
/** A passage above this on `core` (or, with a focus set, on `focus`) is never dimmed. */
export const DIM_CEILING = 0.5;

/** Addendum §2.2: one document's verdicts, re-decided RELATIVELY. An absolute threshold cannot select
 * on an article — every paragraph clears it — so the top `share` of the document by salience (or by
 * focus, when one is set) is highlighted and the least substantive `DIM_SHARE` is dimmed, with the
 * floor and the ceiling as the only absolute guards left.
 *
 * Takes every verdict of one document in any order and returns new objects in that same order (nothing
 * is mutated and nothing is aliased: these cross the extension's message port and are handed to the
 * panel). A verdict that carries `error: true` was never judged at all, so it stays `plain` and is
 * counted in neither the document's size nor either quota. */
export function rankReading(verdicts: ReadingVerdict[], hasFocus: boolean, share = HIGHLIGHT_SHARE): ReadingVerdict[] {
  // Index-carrying copies: the input order is both the output order and the last tie-break, and every
  // sort below is over a different ordering of the same set.
  const ranked = verdicts.map((v, at) => ({ at, out: { ...v } }));
  const judged = ranked.filter(({ out }) => out.error !== true);
  const scoreOf = (v: ReadingVerdict): number => (hasFocus ? v.focus ?? 0 : v.key);

  const highlights = new Set<number>();
  const byScore = [...judged].sort((a, b) => scoreOf(b.out) - scoreOf(a.out) || b.out.core - a.out.core || a.at - b.at);
  const highlightQuota = Math.max(1, Math.ceil(judged.length * share));
  for (const { at, out } of byScore) {
    if (highlights.size >= highlightQuota) break;
    // The floor is what makes "nothing here is worth highlighting" expressible: a document whose best
    // passage is a 0.2 gets no highlights at all rather than its least bad quarter.
    if (scoreOf(out) < HIGHLIGHT_FLOOR) continue;
    highlights.add(at);
  }

  const dims = new Set<number>();
  const byCore = [...judged].sort((a, b) => a.out.core - b.out.core || a.at - b.at);
  const dimQuota = Math.floor(judged.length * DIM_SHARE);
  for (const { at, out } of byCore) {
    if (dims.size >= dimQuota) break;
    if (highlights.has(at)) continue;
    if (out.core > DIM_CEILING) continue;
    // The focus guard, unchanged in spirit from §4.2: you asked about it, so a passage the focus likes
    // is never dimmed for being unsubstantial.
    if (hasFocus && (out.focus ?? 0) > DIM_CEILING) continue;
    dims.add(at);
  }

  for (const { at, out } of ranked) {
    if (highlights.has(at)) {
      out.verdict = 'highlight';
      out.p = scoreOf(out);
    } else {
      out.verdict = dims.has(at) ? 'dim' : 'plain';
      out.p = out.core;
    }
  }
  return ranked.map(({ out }) => out);
}
