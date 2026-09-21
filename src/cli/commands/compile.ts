import { readFile, writeFile } from 'node:fs/promises';
import { compile as compilePack, resolveProviders, type Example } from '../../core/index.js';
import type { RunCtx } from '../args.js';
import { parseJsonl } from '../jsonl.js';
import { providerConfigFromEnv } from '../providers.js';
import { NO_KEY_NOTE } from '../usage.js';

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Parses JSON-lines `Example`s (past corrections fed back into the compile prompt); a line that
 * fails to parse is warned about on stderr and skipped, rather than aborting the whole batch. */
function parseExamplesJsonl(text: string, stderr: (s: string) => void): Example[] {
  return parseJsonl<Example>(text, (lineNo, err) => {
    stderr(`warning: skipping invalid feedback line ${lineNo}: ${describeError(err)}\n`);
  });
}

/** `compile "<intent>" [--with-feedback file.jsonl] [--out file.json]`: compiles a plain-English
 * intent into a QuestionPack and prints it (pretty JSON) to stdout, or writes it to `--out`. */
export async function run(ctx: RunCtx): Promise<number> {
  const intent = ctx.positionals[0] ?? ctx.flags.rules;
  if (!intent || !intent.trim()) {
    ctx.stderr('jev-duo compile: provide an intent as an argument or with --rules\n');
    return 1;
  }

  const { config, usedMock } = providerConfigFromEnv(ctx.env, ctx.flags);
  if (usedMock) ctx.stderr(NO_KEY_NOTE);
  const { llm } = resolveProviders({ ...config, fetchImpl: ctx.fetchImpl });

  let examples: Example[] | undefined;
  if (ctx.flags.withFeedback) {
    const text = await readFile(ctx.flags.withFeedback, 'utf8');
    examples = parseExamplesJsonl(text, ctx.stderr);
  }

  const pack = await compilePack(intent, llm, { examples });
  const json = `${JSON.stringify(pack, null, 2)}\n`;

  if (ctx.flags.out) {
    await writeFile(ctx.flags.out, json, 'utf8');
  } else {
    ctx.stdout(json);
  }
  return 0;
}
