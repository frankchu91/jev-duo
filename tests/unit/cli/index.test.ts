import { describe, it, expect } from 'vitest';
import { main, type CliIo } from '../../../src/cli/index';

function captured(): { out: string[]; err: string[]; io: CliIo } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: {}, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  return { out, err, io };
}

describe('main', () => {
  it('an unknown flag prints a clean one-liner (not a raw stack trace) and exits 1', async () => {
    const { out, err, io } = captured();

    const code = await main(['--nope'], io);

    expect(code).toBe(1);
    const message = err.join('');
    expect(message).toMatch(/^jev-duo: .*\(try --help\)/);
    // The bug this guards against: node:util parseArgs throws a raw TypeError whose stack trace
    // mentions its internal error code and file path — none of that should ever reach the user.
    expect(message).not.toContain('ERR_PARSE_ARGS');
    expect(message).not.toContain('.js:');
    expect(message).not.toContain('    at ');
    expect(out.join('')).toBe('');
  });

  it('an unknown option value (not just an unknown flag name) is also reported cleanly', async () => {
    const { err, io } = captured();
    const code = await main(['judge', '--pack'], io); // --pack requires a value; none given
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/^jev-duo: .*\(try --help\)/);
  });

  it('--version still prints the version and exits 0', async () => {
    const { out, io } = captured();
    const code = await main(['--version'], io);
    expect(code).toBe(0);
    expect(out.join('')).toBe('0.1.0\n');
  });

  it('no command prints usage and exits 0', async () => {
    const { out, io } = captured();
    const code = await main([], io);
    expect(code).toBe(0);
    expect(out.join('')).toContain('Usage:');
  });

  it('an unknown command prints a message plus usage to stderr and exits 1', async () => {
    const { err, io } = captured();
    const code = await main(['frobnicate'], io);
    expect(code).toBe(1);
    expect(err.join('')).toContain('unknown command "frobnicate"');
    expect(err.join('')).toContain('Usage:');
  });

  it('dispatches a real command end to end (compile, with mock providers)', async () => {
    const { out, io } = captured();
    const code = await main(['compile', 'hide crypto'], io);
    expect(code).toBe(0);
    const pack = JSON.parse(out.join(''));
    expect(pack.intent).toBe('hide crypto');
    expect(pack.rules[0].id).toBe('crypto');
  });
});
