import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProviderError, VERSION } from '../core/index.js';
import { parseCli, type RunCtx } from './args.js';
import { run as compileCommand } from './commands/compile.js';
import { run as demoCommand } from './commands/demo.js';
import { run as hnCommand } from './commands/hn.js';
import { run as judgeCommand } from './commands/judge.js';
import { USAGE } from './usage.js';

const COMMANDS: Record<string, (ctx: RunCtx) => Promise<number>> = {
  hn: hnCommand,
  compile: compileCommand,
  judge: judgeCommand,
  demo: demoCommand,
};

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Everything `main` needs from the outside world, injected so it never touches `process` itself —
 * that keeps `main` a plain, testable function of `(argv, io)` with no hidden global dependency.
 * Same shape as `RunCtx` minus `flags`/`positionals` (those are `parseCli`'s job, not the caller's),
 * derived rather than restated so the two can't drift apart. */
export type CliIo = Omit<RunCtx, 'flags' | 'positionals'>;

/** The whole CLI as a function of `(argv, io)`: parses flags, dispatches to a command, and returns
 * an exit code. Never throws and never prints a raw stack trace — a bad flag (from `parseCli`), an
 * unknown command, or anything a command throws all become one `jev-duo: <message>` line on
 * `io.stderr` and a plain return value. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    io.stderr(`jev-duo: ${describeError(err)} (try --help)\n`);
    return 1;
  }
  const { command, flags, positionals } = parsed;

  if (flags.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || command === undefined) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    io.stderr(`jev-duo: unknown command "${command}" (try --help)\n\n`);
    io.stderr(`${USAGE}\n`);
    return 1;
  }

  const ctx: RunCtx = {
    flags,
    positionals,
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: io.fetchImpl,
    readStdin: io.readStdin,
  };

  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof ProviderError) {
      io.stderr(`jev-duo: ${err.message}\n`);
      return 2;
    }
    io.stderr(`jev-duo: ${describeError(err)}\n`);
    return 1;
  }
}

// --- Process wiring below: the only code in this file that touches `process` (or runs on import
// as a side effect). Guarded so requiring/importing this module — e.g. from a test — never runs
// the real CLI or calls `process.exit`; it only fires when this file is the actual entry point. ---

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function runCli(): Promise<number> {
  // Loaded first, before anything else touches argv/env: a missing file (or a Node too old to have
  // `loadEnvFile`) is silently ignored; variables already set in the shell always win.
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file (or Node < 20.12) — fine either way
  }

  const io: CliIo = {
    env: process.env,
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
    fetchImpl: fetch,
    readStdin,
  };

  return main(process.argv.slice(2), io);
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  let code: number;
  try {
    code = await runCli();
  } catch (err) {
    // Last-resort net: nothing above should ever throw past `main`, but if something does (a bug,
    // not a modeled error path), still fail cleanly rather than dump a raw stack trace.
    process.stderr.write(`jev-duo: ${describeError(err)}\n`);
    code = 1;
  }
  process.exit(code);
}
