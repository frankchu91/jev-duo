import { readFile } from 'node:fs/promises';
import { DuoAgent, parsePack, resolveProviders, type Item } from '../../core/index.js';
import type { RunCtx } from '../args.js';
import { providerConfigFromEnv } from '../providers.js';
import { renderJsonl, renderTable } from '../render.js';
import { NO_KEY_NOTE } from '../usage.js';

/** Parses JSON-lines `Item`s; a line that fails to parse is warned about on stderr and skipped,
 * rather than aborting the whole batch. */
function parseItemsJsonl(text: string, stderr: (s: string) => void): Item[] {
  const items: Item[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      items.push(JSON.parse(line) as Item);
    } catch {
      stderr(`warning: skipping invalid item line: ${line.slice(0, 80)}\n`);
    }
  }
  return items;
}

/** `judge --pack pack.json [--input items.jsonl]`: judges JSONL items (file or stdin) against a
 * pre-compiled pack and prints a table or JSONL, one line per item. */
export async function run(ctx: RunCtx): Promise<number> {
  if (!ctx.flags.pack) {
    ctx.stderr('jev-duo judge: --pack <file> is required\n');
    return 1;
  }

  let pack;
  try {
    const text = await readFile(ctx.flags.pack, 'utf8');
    pack = parsePack(JSON.parse(text));
  } catch (err) {
    ctx.stderr(`jev-duo judge: failed to read pack: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const raw = ctx.flags.input ? await readFile(ctx.flags.input, 'utf8') : await (ctx.readStdin ?? (async () => ''))();
  const items = parseItemsJsonl(raw, ctx.stderr);

  const { config, usedMock } = providerConfigFromEnv(ctx.env, ctx.flags);
  if (usedMock) ctx.stderr(NO_KEY_NOTE);
  const providers = resolveProviders({ ...config, fetchImpl: ctx.fetchImpl });

  const agent = new DuoAgent({ jev: providers.jev, llm: providers.llm, pack, settings: { strictness: ctx.flags.strictness } });
  const verdicts = await agent.judge(items);

  const output = ctx.flags.json
    ? renderJsonl(verdicts)
    : renderTable(items, verdicts, { color: true, stats: agent.stats() });
  ctx.stdout(output + '\n');
  return 0;
}
