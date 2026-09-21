import { parseArgs } from 'node:util';
import { DEFAULT_STRICTNESS } from '../core/index.js';

export interface CliFlags {
  rules?: string;
  pack?: string;
  out?: string;
  input?: string;
  limit: number;
  provider?: string;
  llm?: string;
  strictness: number;
  json: boolean;
  arbiter: boolean;
  live: boolean;
  withFeedback?: string;
  help: boolean;
  version: boolean;
}

/** The context every command's `run()` receives: parsed flags/positionals, the environment, output
 * sinks (so tests can capture them instead of touching the real process), and I/O hooks a command
 * needs (HTTP fetch, stdin) that tests can stub out. */
export interface RunCtx {
  flags: CliFlags;
  positionals: string[];
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  fetchImpl?: typeof fetch;
  readStdin?: () => Promise<string>;
}

const DEFAULT_LIMIT = 30;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100; // the Algolia front-page endpoint's own hitsPerPage ceiling

const OPTIONS = {
  rules: { type: 'string' },
  pack: { type: 'string' },
  out: { type: 'string' },
  input: { type: 'string' },
  limit: { type: 'string' },
  provider: { type: 'string' },
  llm: { type: 'string' },
  strictness: { type: 'string' },
  json: { type: 'boolean', default: false },
  arbiter: { type: 'boolean', default: false },
  live: { type: 'boolean', default: false },
  'with-feedback': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

/** Rejects a numeric flag rather than silently falling back to the default: `--limit abc` or
 * `--strictness 5` is a typo the user wants to hear about, and index.ts turns the throw into one
 * `jev-duo: ... (try --help)` line and exit code 1. */
function numberFlag(name: string, raw: string | undefined, fallback: number, opts: { min: number; max: number; integer?: boolean }): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  const shape = opts.integer ? 'an integer' : 'a number';
  if (raw.trim() === '' || !Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || n < opts.min || n > opts.max) {
    throw new Error(`--${name} must be ${shape} between ${opts.min} and ${opts.max} (got "${raw}")`);
  }
  return n;
}

/** Thin wrapper over `node:util` `parseArgs`: the first positional is the command, the rest are
 * passed through (e.g. `compile`'s intent argument). Unknown flags throw (parseArgs `strict` mode). */
export function parseCli(argv: string[]): { command: string | undefined; flags: CliFlags; positionals: string[] } {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });

  const flags: CliFlags = {
    rules: values.rules,
    pack: values.pack,
    out: values.out,
    input: values.input,
    limit: numberFlag('limit', values.limit, DEFAULT_LIMIT, { min: LIMIT_MIN, max: LIMIT_MAX, integer: true }),
    provider: values.provider,
    llm: values.llm,
    strictness: numberFlag('strictness', values.strictness, DEFAULT_STRICTNESS, { min: 0, max: 1 }),
    json: values.json ?? false,
    arbiter: values.arbiter ?? false,
    live: values.live ?? false,
    withFeedback: values['with-feedback'],
    help: values.help ?? false,
    version: values.version ?? false,
  };

  return { command: positionals[0], flags, positionals: positionals.slice(1) };
}
