import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../../../src/core/providers/types';
import {
  CORE_STATEMENT,
  JUDGE_TEXT_MAX,
  KIND_OPTIONS,
  decideReading,
  passageId,
  readingQuestions,
  readingState,
  type DocContext,
  type Passage,
} from '../../../src/core/reading';

const CTX: DocContext = { title: 'Attention Layers', lead: 'We study attention.', source: 'https://example.test/paper' };
const passage = (text: string): Passage => ({ id: passageId(text), index: 0, text });

const noul = (id: string, p: number): JevAnswer => ({ id, type: 'noul', p });
const choice = (id: string, c: string): JevAnswer => ({ id, type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });

describe('readingQuestions', () => {
  it('without a focus asks core then kind, in that order', () => {
    const qs = readingQuestions('');
    expect(qs.map((q) => q.id)).toEqual(['core', 'kind']);
    expect(qs[0]).toEqual({ id: 'core', type: 'noul', statement: CORE_STATEMENT });
    expect(qs[1]).toEqual({ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS });
    expect(KIND_OPTIONS).toEqual(['claim', 'method', 'result', 'background', 'boilerplate']);
  });

  it('with a focus inserts the focus question between core and kind, with the text inlined', () => {
    const qs = readingQuestions('  how is positional information represented  ');
    expect(qs.map((q) => q.id)).toEqual(['core', 'focus', 'kind']);
    expect(qs[1]).toEqual({
      id: 'focus',
      type: 'noul',
      statement: 'The passage contains information that directly addresses the reader\'s question: "how is positional information represented".',
    });
  });

  it('treats whitespace as no focus at all', () => {
    expect(readingQuestions('   ').map((q) => q.id)).toEqual(['core', 'kind']);
  });
});

describe('readingState', () => {
  it('carries the title, the lead and the passage text', () => {
    expect(readingState(CTX, passage('A claim about attention.'))).toEqual({
      document_title: 'Attention Layers',
      document_lead: 'We study attention.',
      passage: 'A claim about attention.',
    });
  });

  it('truncates the passage at JUDGE_TEXT_MAX', () => {
    const long = 'x'.repeat(JUDGE_TEXT_MAX + 500);
    const state = readingState(CTX, passage(long));
    expect(JUDGE_TEXT_MAX).toBe(1500);
    expect(String(state.passage)).toHaveLength(JUDGE_TEXT_MAX);
  });
});

describe('passageId', () => {
  it('is stable, prefixed and derived from the first 300 chars only', () => {
    const head = 'y'.repeat(300);
    expect(passageId('hello')).toBe(passageId('hello'));
    expect(passageId('hello')).toMatch(/^rd:\d+$/);
    expect(passageId(`${head}a`)).toBe(passageId(`${head}b`));
  });
});

describe('decideReading', () => {
  // The table from spec §12, with the one row that §4.2 overrides — see the plan's Decisions (1).
  it.each([
    ['core .9, no focus', [noul('core', 0.9)], false, 'highlight', 0.9],
    ['core .7', [noul('core', 0.7)], false, 'highlight', 0.7],
    ['core .69', [noul('core', 0.69)], false, 'plain', 0.69],
    ['core .3', [noul('core', 0.3)], false, 'dim', 0.3],
    ['core .31', [noul('core', 0.31)], false, 'plain', 0.31],
    ['focus .6, core .2', [noul('core', 0.2), noul('focus', 0.6)], true, 'highlight', 0.6],
    ['focus .59, core .2', [noul('core', 0.2), noul('focus', 0.59)], true, 'plain', 0.59],
    ['focus .2, core .2', [noul('core', 0.2), noul('focus', 0.2)], true, 'dim', 0.2],
    ['focus .59, core .5', [noul('core', 0.5), noul('focus', 0.59)], true, 'plain', 0.59],
  ])('%s -> %s', (_label, answers, hasFocus, verdict, p) => {
    const v = decideReading('rd:1', answers as JevAnswer[], hasFocus as boolean);
    expect(v.verdict).toBe(verdict);
    expect(v.p).toBeCloseTo(p as number, 10);
  });

  it('treats a missing core answer as 0.5 and stays plain', () => {
    expect(decideReading('rd:1', [], false)).toEqual({ id: 'rd:1', verdict: 'plain', p: 0.5, core: 0.5 });
  });

  it('copies the kind choice and the focus probability onto the verdict', () => {
    const v = decideReading('rd:2', [noul('core', 0.8), noul('focus', 0.9), choice('kind', 'method')], true);
    expect(v).toEqual({ id: 'rd:2', verdict: 'highlight', p: 0.9, core: 0.8, focus: 0.9, kind: 'method' });
  });

  it('ignores a focus answer when no focus was set', () => {
    const v = decideReading('rd:3', [noul('core', 0.9), noul('focus', 0.1)], false);
    expect(v.p).toBe(0.9);
    expect(v.verdict).toBe('highlight');
  });
});
