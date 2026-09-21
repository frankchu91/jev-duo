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
  'with-feedback': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

function toNumber(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
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
    limit: toNumber(values.limit, DEFAULT_LIMIT),
    provider: values.provider,
    llm: values.llm,
    strictness: toNumber(values.strictness, DEFAULT_STRICTNESS),
    json: values.json ?? false,
    withFeedback: values['with-feedback'],
    help: values.help ?? false,
    version: values.version ?? false,
  };

  return { command: positionals[0], flags, positionals: positionals.slice(1) };
}
