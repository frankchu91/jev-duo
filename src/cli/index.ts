import { ProviderError, VERSION } from '../core/index.js';
import { parseCli, type RunCtx } from './args.js';
import { run as compileCommand } from './commands/compile.js';
import { run as demoCommand } from './commands/demo.js';
import { run as hnCommand } from './commands/hn.js';
import { run as judgeCommand } from './commands/judge.js';
import { USAGE } from './usage.js';

// Loaded first, before anything else touches argv/env: a missing file (or a Node too old to have
// `loadEnvFile`) is silently ignored; variables already set in the shell always win.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file (or Node < 20.12) — fine either way
}

const COMMANDS: Record<string, (ctx: RunCtx) => Promise<number>> = {
  hn: hnCommand,
  compile: compileCommand,
  judge: judgeCommand,
  demo: demoCommand,
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(argv: string[]): Promise<number> {
  const { command, flags, positionals } = parseCli(argv);

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`jev-duo: unknown command "${command}" (try --help)\n\n`);
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const ctx: RunCtx = {
    flags,
    positionals,
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

  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof ProviderError) {
      process.stderr.write(`jev-duo: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`jev-duo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
