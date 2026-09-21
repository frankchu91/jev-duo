import { DuoAgent, resolveProviders } from '../../core/index.js';
import type { RunCtx } from '../args.js';
import { renderTable } from '../render.js';
import { SAMPLE_FEED } from '../sample-feed.js';
import { run as hnRun } from './hn.js';

export const DEMO_INTENT =
  'Hide crypto and token launches, political outrage, and layoffs drama. Dim product launch announcements. Keep anything about Rust, databases, or open source tools.';

/** `demo`: the whole loop — compile an intent, judge a feed, print the table — with mock providers,
 * so it needs no API keys. By default it judges the bundled sample feed, which also means it needs no
 * network and always prints the same thing; `--live` points the same run at the real Hacker News
 * front page instead. */
export async function run(ctx: RunCtx): Promise<number> {
  if (ctx.flags.live) {
    ctx.stdout('jev-duo demo — mock providers, Hacker News front page\n');
    return hnRun({
      ...ctx,
      flags: { ...ctx.flags, provider: 'mock', llm: 'mock', rules: DEMO_INTENT, pack: undefined },
    });
  }

  ctx.stdout('jev-duo demo — mock providers, bundled sample feed\n');
  const { jev, llm } = resolveProviders({ jev: 'mock', llm: 'mock', keys: {} });
  const agent = new DuoAgent({ jev, llm, settings: { strictness: ctx.flags.strictness, arbiter: ctx.flags.arbiter } });
  await agent.compile(DEMO_INTENT);
  const verdicts = await agent.judge(SAMPLE_FEED);
  ctx.stdout(renderTable(SAMPLE_FEED, verdicts, { color: true, stats: agent.stats() }) + '\n');
  return 0;
}
