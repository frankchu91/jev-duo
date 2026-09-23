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

export const KIND_OPTIONS = ['claim', 'method', 'result', 'background', 'boilerplate'];

/** The per-passage question list (§4.1), in order: core, then focus only when one is set, then kind. */
export function readingQuestions(focus: string): JevQuestion[] {
  const trimmed = focus.trim();
  const questions: JevQuestion[] = [{ id: 'core', type: 'noul', statement: CORE_STATEMENT }];
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
  /** The probability the decision was made on: focus when a focus is set, else core. */
  p: number;
  core: number;
  focus?: number;
  kind?: string;
  error?: true;
}

export const T_HIGHLIGHT_CORE = 0.7;
export const T_HIGHLIGHT_FOCUS = 0.6;
export const T_DIM = 0.3;

/** §4.2. Fixed thresholds: the strictness slider is a feed-mode control and deliberately does not
 * apply here (§13). A passage with no `core` answer is treated as 0.5 — squarely plain — so a
 * malformed reply shows the passage as the page rendered it rather than dimming it. */
export function decideReading(id: string, answers: JevAnswer[], hasFocus: boolean): ReadingVerdict {
  let core = 0.5;
  let focus: number | undefined;
  let kind: string | undefined;
  for (const a of answers) {
    if (a.type === 'noul' && a.id === 'core') core = a.p;
    else if (a.type === 'noul' && a.id === 'focus') focus = a.p;
    else if (a.type === 'choice' && a.id === 'kind') kind = a.choice;
  }

  // With a focus set but no focus answer (a provider that dropped a question), `core` stands in for it
  // rather than the passage silently defaulting to 0.
  const decisive = hasFocus ? focus ?? core : core;
  const highlight = hasFocus ? decisive >= T_HIGHLIGHT_FOCUS : core >= T_HIGHLIGHT_CORE;
  // The focus guard is why a half-relevant passage is never dimmed: you asked about it.
  const dim = core <= T_DIM && (!hasFocus || decisive <= T_DIM);

  const out: ReadingVerdict = { id, verdict: highlight ? 'highlight' : dim ? 'dim' : 'plain', p: decisive, core };
  if (focus !== undefined) out.focus = focus;
  if (kind !== undefined) out.kind = kind;
  return out;
}
