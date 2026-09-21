import { describe, expect, it } from 'vitest';
import { parseCli } from '../../../src/cli/args';

describe('parseCli', () => {
  it('defaults: limit 30, strictness 0.5, arbiter and live off', () => {
    const { flags } = parseCli(['hn', '--rules', 'hide crypto']);
    expect(flags).toMatchObject({ limit: 30, strictness: 0.5, arbiter: false, live: false, json: false });
  });

  it('--arbiter and --live are opt-in booleans', () => {
    const { flags } = parseCli(['demo', '--arbiter', '--live']);
    expect(flags.arbiter).toBe(true);
    expect(flags.live).toBe(true);
  });

  // A typo in a numeric flag used to fall back to the default silently, so `--limit 1O0` judged 30
  // posts and `--strictness 7` ran at 0.5 while the user believed otherwise.
  describe('--limit', () => {
    it('accepts integers from 1 to 100', () => {
      expect(parseCli(['hn', '--limit', '1']).flags.limit).toBe(1);
      expect(parseCli(['hn', '--limit', '100']).flags.limit).toBe(100);
    });

    // `--limit=-5` rather than `--limit -5`: parseArgs rejects a dash-leading value of its own accord
    // (with its own clear message), so the `=` form is what actually reaches this validation.
    for (const bad of ['0', '101', '=-5', '2.5', 'abc', '']) {
      it(`rejects "${bad}" with a usage error naming the flag`, () => {
        const argv = bad.startsWith('=') ? ['hn', `--limit${bad}`] : ['hn', '--limit', bad];
        expect(() => parseCli(argv)).toThrow(/--limit must be an integer between 1 and 100/);
      });
    }
  });

  describe('--strictness', () => {
    it('accepts 0 through 1, including fractions', () => {
      expect(parseCli(['hn', '--strictness', '0']).flags.strictness).toBe(0);
      expect(parseCli(['hn', '--strictness', '0.85']).flags.strictness).toBe(0.85);
      expect(parseCli(['hn', '--strictness', '1']).flags.strictness).toBe(1);
    });

    for (const bad of ['=-0.1', '1.5', '70', 'high', '']) {
      it(`rejects "${bad}" with a usage error naming the flag`, () => {
        const argv = bad.startsWith('=') ? ['hn', `--strictness${bad}`] : ['hn', '--strictness', bad];
        expect(() => parseCli(argv)).toThrow(/--strictness must be a number between 0 and 1/);
      });
    }
  });
});
