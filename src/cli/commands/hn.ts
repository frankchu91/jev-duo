import { readFile } from 'node:fs/promises';
import { DuoAgent, parsePack, resolveProviders } from '../../core/index.js';
import type { RunCtx } from '../args.js';
import { providerConfigFromEnv } from '../providers.js';
import { renderJsonl, renderTable } from '../render.js';
import { fetchHnFrontPage } from '../sources/hn.js';
import { NO_KEY_NOTE } from '../usage.js';

/** `hn [--pack file | --rules intent] [--limit n]`: judges the live Hacker News front page and
 * prints a table or JSONL, one line per item. */
export async function run(ctx: RunCtx): Promise<number> {
  if (!ctx.flags.pack && !ctx.flags.rules) {
    ctx.stderr('jev-duo hn: provide --pack <file> or --rules <intent>\n');
    return 1;
  }

  const { config, usedMock } = providerConfigFromEnv(ctx.env, ctx.flags);
  if (usedMock) ctx.stderr(NO_KEY_NOTE);
  const providers = resolveProviders({ ...config, fetchImpl: ctx.fetchImpl });

  // The arbiter is opt-in on the CLI (spec §4.5): a terminal run is a batch of dozens of posts at
  // once, where silently spending LLM calls on the gray zone is a surprise, not a service.
  const agent = new DuoAgent({ jev: providers.jev, llm: providers.llm, settings: { strictness: ctx.flags.strictness, arbiter: ctx.flags.arbiter } });

  if (ctx.flags.pack) {
    try {
      const text = await readFile(ctx.flags.pack, 'utf8');
      agent.setPack(parsePack(JSON.parse(text)));
    } catch (err) {
      ctx.stderr(`jev-duo hn: failed to read pack: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  } else {
    await agent.compile(ctx.flags.rules!);
  }

  const items = await fetchHnFrontPage(ctx.flags.limit, ctx.fetchImpl);
  const verdicts = await agent.judge(items);

  const output = ctx.flags.json
    ? renderJsonl(verdicts)
    : renderTable(items, verdicts, { color: true, stats: agent.stats() });
  ctx.stdout(output + '\n');
  return 0;
}
