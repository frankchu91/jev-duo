import { describe, it, expect } from 'vitest';
import { extractJson } from '../../../src/core/json';
describe('extractJson', () => {
  it('parses plain JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('strips code fences and prose', () => expect(extractJson('Sure:\n```json\n{"a":[1,2]}\n```\nDone.')).toEqual({ a: [1, 2] }));
  it('throws on no object', () => expect(() => extractJson('nothing here')).toThrow());
});
