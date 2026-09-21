import type { RunCtx } from '../args.js';
import { run as hnRun } from './hn.js';

export const DEMO_INTENT =
  'Hide crypto and token launches, political outrage, and layoffs drama. Dim product launch announcements. Keep anything about Rust, databases, or open source tools.';

/** `demo`: `hn --provider mock --llm mock --rules DEMO_INTENT`, with a header line so it's obvious
 * no API keys are needed. Still hits the live Hacker News Algolia API. */
export async function run(ctx: RunCtx): Promise<number> {
  ctx.stdout('jev-duo demo — mock providers, Hacker News front page\n');
  return hnRun({
    ...ctx,
    flags: { ...ctx.flags, provider: 'mock', llm: 'mock', rules: DEMO_INTENT, pack: undefined },
  });
}
