import { describe, it, expect } from 'vitest';
import { parseJsonl } from '../../../src/cli/jsonl';

describe('parseJsonl', () => {
  it('parses one JSON value per line, skipping blank lines', () => {
    const text = '{"a":1}\n\n{"a":2}\n';
    const out = parseJsonl<{ a: number }>(text, () => {
      throw new Error('onBadLine should not fire for valid input');
    });
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('calls onBadLine with the 1-indexed line number and the parse error, and skips that line', () => {
    const text = '{"a":1}\nnot json\n{"a":2}\n';
    const bad: Array<{ lineNo: number; err: unknown }> = [];
    const out = parseJsonl<{ a: number }>(text, (lineNo, err) => bad.push({ lineNo, err }));

    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
    expect(bad).toHaveLength(1);
    expect(bad[0].lineNo).toBe(2);
    expect(bad[0].err).toBeInstanceOf(Error);
  });

  it('returns an empty array for empty or all-blank input', () => {
    const onBadLine = () => {
      throw new Error('should not be called');
    };
    expect(parseJsonl('', onBadLine)).toEqual([]);
    expect(parseJsonl('\n\n  \n', onBadLine)).toEqual([]);
  });
});
