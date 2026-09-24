import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../../../src/core/providers/types';
import {
  CORE_STATEMENT,
  DIM_SHARE,
  HIGHLIGHT_SHARE,
  JUDGE_TEXT_MAX,
  KEY_STATEMENT,
  KIND_OPTIONS,
  decideReading,
  passageId,
  rankReading,
  readingQuestions,
  readingState,
  type DocContext,
  type Passage,
  type ReadingVerdict,
} from '../../../src/core/reading';

const CTX: DocContext = { title: 'Attention Layers', lead: 'We study attention.', source: 'https://example.test/paper' };
const passage = (text: string): Passage => ({ id: passageId(text), index: 0, text });

const noul = (id: string, p: number): JevAnswer => ({ id, type: 'noul', p });
const choice = (id: string, c: string): JevAnswer => ({ id, type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 });

describe('readingQuestions', () => {
  it('without a focus asks core, key then kind, in that order', () => {
    const qs = readingQuestions('');
    expect(qs.map((q) => q.id)).toEqual(['core', 'key', 'kind']);
    expect(qs[0]).toEqual({ id: 'core', type: 'noul', statement: CORE_STATEMENT });
    expect(qs[1]).toEqual({ id: 'key', type: 'noul', statement: KEY_STATEMENT });
    expect(qs[2]).toEqual({ id: 'kind', type: 'choice', question: 'Which best describes the passage?', options: KIND_OPTIONS });
    expect(KIND_OPTIONS).toEqual(['claim', 'method', 'result', 'background', 'boilerplate']);
  });

  // §2.1: salience is asked about directly rather than inferred from `core`, which on an article is
  // high for every paragraph — the whole reason for the ranking below.
  it('asks about salience in the words the design fixes', () => {
    expect(KEY_STATEMENT).toBe(
      'This passage is one of the few a reader skimming the document for its essentials must not miss — a central claim, a key result or number, a decisive quotation, or the conclusion — rather than a supporting, connective, or illustrative passage.',
    );
  });

  it('with a focus inserts the focus question between key and kind, with the text inlined', () => {
    const qs = readingQuestions('  how is positional information represented  ');
    expect(qs.map((q) => q.id)).toEqual(['core', 'key', 'focus', 'kind']);
    expect(qs[2]).toEqual({
      id: 'focus',
      type: 'noul',
      statement: 'The passage contains information that directly addresses the reader\'s question: "how is positional information represented".',
    });
  });

  it('treats whitespace as no focus at all', () => {
    expect(readingQuestions('   ').map((q) => q.id)).toEqual(['core', 'key', 'kind']);
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
    expect(decideReading('rd:1', [], false)).toEqual({ id: 'rd:1', verdict: 'plain', p: 0.5, core: 0.5, key: 0.5 });
  });

  it('copies the kind choice and the focus probability onto the verdict', () => {
    const v = decideReading('rd:2', [noul('core', 0.8), noul('focus', 0.9), choice('kind', 'method')], true);
    expect(v).toEqual({ id: 'rd:2', verdict: 'highlight', p: 0.9, core: 0.8, key: 0.5, focus: 0.9, kind: 'method' });
  });

  // §2.1: the verdict carries the salience answer as a required number, so the ranking never has to
  // ask whether the provider happened to answer it — a missing answer is squarely 0.5, like `core`.
  it('fills key from the key answer, and treats a missing one as 0.5', () => {
    expect(decideReading('rd:7', [noul('core', 0.9), noul('key', 0.88)], false).key).toBe(0.88);
    expect(decideReading('rd:8', [noul('core', 0.9)], false).key).toBe(0.5);
  });

  // Final wave: the documented fallback when a focus IS set but the provider dropped the focus
  // question — `core` stands in for it, rather than the passage silently deciding on 0.
  it('falls back to core as the decisive probability when a focus answer is missing', () => {
    const high = decideReading('rd:4', [noul('core', 0.8)], true);
    expect(high).toEqual({ id: 'rd:4', verdict: 'highlight', p: 0.8, core: 0.8, key: 0.5 }); // 0.8 >= the 0.6 focus bar
    expect(high.focus).toBeUndefined(); // nothing is invented onto the verdict

    // And the same stand-in decides the dim: core 0.2 is under both thresholds.
    expect(decideReading('rd:5', [noul('core', 0.2)], true).verdict).toBe('dim');
    // Between the two bars it is plain, exactly as it would be with a focus answer of 0.5.
    expect(decideReading('rd:6', [noul('core', 0.5)], true).verdict).toBe('plain');
  });

  it('ignores a focus answer when no focus was set', () => {
    const v = decideReading('rd:3', [noul('core', 0.9), noul('focus', 0.1)], false);
    expect(v.p).toBe(0.9);
    expect(v.verdict).toBe('highlight');
  });
});

// --- Design addendum 2026-09-23 §2.2: highlights are the top share of ONE document, not everything
// over an absolute line. Measured on a real news article, every paragraph scored `core` 0.86–0.94 and
// all eleven were highlighted; ranking is what makes a selection possible at all. ---

describe('rankReading', () => {
  /** One judged verdict as `decideReading` hands it over: a provisional `plain`, its `p` still `core`. */
  const judged = (id: string, core: number, key: number, extra: Partial<ReadingVerdict> = {}): ReadingVerdict => ({
    id,
    verdict: 'plain',
    p: core,
    core,
    key,
    ...extra,
  });

  const kinds = (verdicts: ReadingVerdict[]): string[] => verdicts.map((v) => v.verdict);
  const idsOf = (verdicts: ReadingVerdict[], kind: ReadingVerdict['verdict']): string[] => verdicts.filter((v) => v.verdict === kind).map((v) => v.id);
  const count = (verdicts: ReadingVerdict[], kind: ReadingVerdict['verdict']): number => idsOf(verdicts, kind).length;

  it('uses the shares the design fixes', () => {
    expect(HIGHLIGHT_SHARE).toBe(0.25);
    expect(DIM_SHARE).toBe(0.2);
  });

  // The field-test document, verbatim: eleven paragraphs whose `core` the absolute rule put every one
  // of over the line. ceil(11 × 0.25) = 3 highlights, and nothing is substantive enough to dim.
  it('highlights the top quarter of eleven near-identical passages, and dims none of them', () => {
    const scores = [0.86, 0.9, 0.94, 0.88, 0.92, 0.87, 0.91, 0.93, 0.89, 0.9, 0.88];
    const ranked = rankReading(
      scores.map((s, i) => judged(`rd:${i}`, s, s)),
      false,
    );

    expect(count(ranked, 'highlight')).toBe(3);
    expect(count(ranked, 'dim')).toBe(0);
    expect(idsOf(ranked, 'highlight')).toEqual(['rd:2', 'rd:4', 'rd:7']); // keys 0.94, 0.92, 0.93
    expect(ranked[2].p).toBe(0.94); // a highlight's p is the score it was ranked on
  });

  it('highlights nothing when no passage reaches the floor, and dims the least substantive fifth', () => {
    const cores = [0.9, 0.2, 0.8, 0.45, 0.7, 0.1, 0.6, 0.55, 0.5, 0.65, 0.75];
    const ranked = rankReading(
      cores.map((core, i) => judged(`rd:${i}`, core, 0.2)),
      false,
    );

    expect(count(ranked, 'highlight')).toBe(0);
    expect(idsOf(ranked, 'dim')).toEqual(['rd:1', 'rd:5']); // floor(11 × 0.2) = 2, the two lowest cores
    expect(ranked.every((v) => v.p === v.core)).toBe(true); // nothing highlighted, so every p is core
  });

  it('never dims a passage whose core is over the ceiling, however small the document', () => {
    const ranked = rankReading(
      [0.9, 0.8, 0.7, 0.6, 0.55].map((core, i) => judged(`rd:${i}`, core, 0.1)),
      false,
    );
    expect(count(ranked, 'dim')).toBe(0); // the quota is 1, but 0.55 is over DIM_CEILING
  });

  // Fix round 1: a document where the salience answers come back identical still has to pick somebody,
  // and it picks on substance — then, failing that, on where the passage sits in the document.
  it('breaks a tie on the score with core, and a tie on both with document order', () => {
    const ranked = rankReading(
      [judged('rd:0', 0.6, 0.8), judged('rd:1', 0.9, 0.8), judged('rd:2', 0.9, 0.8), judged('rd:3', 0.7, 0.8)],
      false,
    );

    // ceil(4 × 0.25) = 1 slot: the highest core takes it, and of the two passages tied at 0.9 the
    // earlier one does.
    expect(idsOf(ranked, 'highlight')).toEqual(['rd:1']);
    expect(ranked[1].p).toBe(0.8);
  });

  it('a lone passage worth reading is highlighted, and a lone unremarkable one is plain', () => {
    expect(kinds(rankReading([judged('rd:0', 0.8, 0.9)], false))).toEqual(['highlight']);
    expect(kinds(rankReading([judged('rd:0', 0.8, 0.3)], false))).toEqual(['plain']);
  });

  it('treats the floor and the ceiling as inclusive', () => {
    expect(kinds(rankReading([judged('rd:0', 0.8, 0.5)], false))).toEqual(['highlight']);
    expect(kinds(rankReading([judged('rd:0', 0.8, 0.49)], false))).toEqual(['plain']);
    // Ten passages, so two dim slots — and the only passage eligible for one sits exactly on the ceiling.
    const onTheCeiling = rankReading(
      [0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9].map((core, i) => judged(`rd:${i}`, core, 0.1)),
      false,
    );
    expect(idsOf(onTheCeiling, 'dim')).toEqual(['rd:0']);
  });

  it('ranks on focus when one is set, and guards the dims with it too', () => {
    const focuses = [0.9, 0.6, 0.1, 0.1];
    const cores = [0.9, 0.5, 0.2, 0.8];
    const ranked = rankReading(
      focuses.map((focus, i) => ({ ...judged(`rd:${i}`, cores[i], 0.2), focus })),
      true,
    );

    // ceil(4 × 0.25) = 1: the 0.6 is over the floor and still not in the top share.
    expect(kinds(ranked)).toEqual(['highlight', 'plain', 'plain', 'plain']);
    expect(ranked[0].p).toBe(0.9); // the focus probability, not core
    expect(ranked[2].p).toBe(0.2);
    // floor(4 × 0.2) = 0, so the only dim candidate (rd:2, focus 0.1 and core 0.2) misses out too.
    expect(count(ranked, 'dim')).toBe(0);
  });

  it('with a focus set, a passage the focus likes is never dimmed however low its core', () => {
    const verdicts = [
      { ...judged('rd:0', 0.1, 0.2), focus: 0.9 }, // core says filler, the focus says otherwise
      { ...judged('rd:1', 0.2, 0.2), focus: 0.05 },
      ...[0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9].map((core, i) => ({ ...judged(`rd:${i + 2}`, core, 0.2), focus: 0.8 })),
    ];

    const ranked = rankReading(verdicts, true);

    // Two dim slots (floor(10 × 0.2)), and only one passage is under both bars.
    expect(idsOf(ranked, 'dim')).toEqual(['rd:1']);
  });

  it('never highlights an errored verdict, and leaves it out of the count the share is taken of', () => {
    const verdicts = [
      judged('rd:err', 0.5, 0.95, { error: true }), // the top score, and unjudged
      judged('rd:0', 0.9, 0.9),
      judged('rd:1', 0.9, 0.8),
      judged('rd:2', 0.9, 0.7),
      judged('rd:3', 0.9, 0.6),
    ];

    const ranked = rankReading(verdicts, false);

    // Four judged passages, so ceil(4 × 0.25) = 1 — not the 2 a count of five would have allowed.
    expect(idsOf(ranked, 'highlight')).toEqual(['rd:0']);
    expect(ranked[0]).toMatchObject({ id: 'rd:err', verdict: 'plain', error: true });
  });

  it('never dims an errored verdict either, however low its core', () => {
    const verdicts = [
      judged('rd:err', 0.01, 0.1, { error: true }),
      ...[0.05, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9].map((core, i) => judged(`rd:${i}`, core, 0.1)),
    ];

    const ranked = rankReading(verdicts, false);

    // Nine judged passages: floor(9 × 0.2) = 1 dim slot, not the 2 a count of ten would have given.
    expect(idsOf(ranked, 'dim')).toEqual(['rd:0']);
    expect(ranked[0].verdict).toBe('plain');
  });

  it('keeps the input order, returns new objects, and mutates nothing', () => {
    const input = [judged('rd:0', 0.2, 0.1), judged('rd:1', 0.9, 0.9), judged('rd:2', 0.4, 0.2)];

    const ranked = rankReading(input, false);

    expect(ranked.map((v) => v.id)).toEqual(['rd:0', 'rd:1', 'rd:2']);
    ranked.forEach((v, i) => expect(v).not.toBe(input[i]));
    expect(input.every((v) => v.verdict === 'plain')).toBe(true);
    expect(ranked[1].verdict).toBe('highlight');
  });

  it('honours the share the reader chose', () => {
    const eleven = [0.86, 0.9, 0.94, 0.88, 0.92, 0.87, 0.91, 0.93, 0.89, 0.9, 0.88].map((s, i) => judged(`rd:${i}`, s, s));

    expect(count(rankReading(eleven, false, 0.15), 'highlight')).toBe(2); // ceil(11 × 0.15)
    expect(count(rankReading(eleven, false, 0.4), 'highlight')).toBe(5); // ceil(11 × 0.4)
    expect(count(rankReading(eleven, false), 'highlight')).toBe(3); // the default share
  });

  it('answers an empty document with an empty list', () => {
    expect(rankReading([], false)).toEqual([]);
  });
});
