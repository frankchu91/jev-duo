import { describe, it, expect } from 'vitest';
import { createMockJev } from '../../../src/core/providers/jev/mock';
import { createMockLlm, splitIntent, slugify } from '../../../src/core/providers/llm/mock';
import { ProviderError } from '../../../src/core/providers/types';

describe('mock jev', () => {
  it('scores noul higher when the statement overlaps the text', async () => {
    const jev = createMockJev();
    const hi = await jev.evaluate({ state: { text: 'Bitcoin token launch, buy now, 100x guaranteed' }, questions: [{ id: 'r_crypto', type: 'noul', statement: 'This post is promoting a crypto token launch.' }] });
    const lo = await jev.evaluate({ state: { text: 'Rust 1.90 released with async traits' }, questions: [{ id: 'r_crypto', type: 'noul', statement: 'This post is promoting a crypto token launch.' }] });
    const pHi = (hi.answers[0] as { p: number }).p, pLo = (lo.answers[0] as { p: number }).p;
    expect(pHi).toBeGreaterThan(0.6); expect(pLo).toBeLessThan(0.3);
    expect(pHi).toBeLessThanOrEqual(0.98); expect(pLo).toBeGreaterThanOrEqual(0.02);
  });
  it('is deterministic', async () => {
    const jev = createMockJev(); const req = { state: { text: 'hello world politics' }, questions: [{ id: 'r_pol', type: 'noul' as const, statement: 'This post is about politics.' }] };
    expect(await jev.evaluate(req)).toEqual(await jev.evaluate(req));
  });
  it('honours fixtures by itemId and question id', async () => {
    const jev = createMockJev({ fixtures: { 'x:1': { 'r_rage': 0.93 } } });
    const r = await jev.evaluate({ state: { text: 'anything' }, questions: [{ id: 'r_rage', type: 'noul', statement: 's' }], meta: { itemId: 'x:1' } });
    expect(r.answers[0]).toEqual({ id: 'r_rage', type: 'noul', p: 0.93 });
  });
  it('answers choice and score', async () => {
    const jev = createMockJev();
    const r = await jev.evaluate({ state: { text: 'a bug report about a crash' }, questions: [
      { id: 'c', type: 'choice', question: 'What kind of post?', options: ['bug report', 'feature request', 'question'] },
      { id: 's', type: 'score', question: 'How urgent?', levels: ['can wait', 'this week', 'blocking a crash right now'] } ] });
    expect(r.answers[0]).toMatchObject({ type: 'choice', choice: 'bug report' });
    expect(r.answers[1]).toMatchObject({ type: 'score', score: 2 });
    const s = r.answers[1] as { score: number }; expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(2);
  });
});

describe('splitIntent', () => {
  it('splits hide clauses and keep clauses', () => {
    const out = splitIntent('Hide ragebait, crypto shilling, and engagement bait. Dim product launches. Keep anything about Rust.');
    expect(out.rules.map((r) => r.id)).toEqual(['ragebait', 'crypto-shilling', 'engagement-bait', 'product-launches']);
    expect(out.rules.map((r) => r.action)).toEqual(['fold', 'fold', 'fold', 'dim']);
    expect(out.keeps.map((k) => k.id)).toEqual(['anything-about-rust']);
    expect(out.rules[0].question).toBe('This post is best described as: ragebait.');
  });
  it('defaults a bare clause to a fold rule', () => {
    expect(splitIntent('politics').rules[0]).toMatchObject({ id: 'politics', action: 'fold' });
  });
  it('slugify', () => { expect(slugify('Crypto Shilling!!')).toBe('crypto-shilling'); expect(slugify('x'.repeat(50))).toHaveLength(40); });
});

describe('mock llm', () => {
  it('compiles the <intent> block into pack JSON', async () => {
    const llm = createMockLlm();
    const text = await llm.completeJson('sys', 'stuff\n<intent>\nhide ragebait\n</intent>\n');
    expect(JSON.parse(text)).toEqual({ rules: [{ id: 'ragebait', label: 'ragebait', question: 'This post is best described as: ragebait.', action: 'fold' }], keeps: [], notes: 'mock compiler: split intent into clauses' });
  });
  it('answers <arbiter> prompts with a no-hide verdict', async () => {
    const llm = createMockLlm();
    expect(JSON.parse(await llm.completeJson('sys', '<arbiter>\n{"x":1}\n</arbiter>'))).toEqual({ hide: false, why: 'mock arbiter' });
  });
  it('throws ProviderError when no <intent> block is present', async () => {
    const llm = createMockLlm();
    await expect(llm.completeJson('sys', 'no tags in here')).rejects.toThrow(ProviderError);
  });
});
