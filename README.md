# jev-duo

A two-brain agent that reads your feeds with you: an LLM writes the rules, Jev enforces them at
roughly 100 ms per post.

Works on x.com, reddit.com and news.ycombinator.com as a Chrome extension, and on the Hacker News
front page (or any JSONL) from the terminal as `jev-duo`.

## How it works

1. You write, in plain English, what you do not want to see and what you always want to keep.
2. System 2 (an LLM, called once) compiles that sentence into a pack of independent, typed questions.
3. System 1 (TypeSafe's Jev) answers the whole pack for every post that scrolls into view.
4. Posts over threshold are folded, dimmed or badged; every "Wrong" click becomes an example that
   System 2 folds into the next recompile.

Everything fails open. If a provider errors, times out or runs out of budget, the post stays visible.

## Install the extension

There is no Web Store listing yet, so build it from source:

```bash
git clone https://github.com/frankchu91/jev-duo.git
cd jev-duo
pnpm install
pnpm build
```

Then load it:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dist/extension` directory.

`pnpm package:ext` writes `jev-duo-extension.zip` with `manifest.json` at the zip root, if you want a
single file to move between machines. Chrome 120 or newer is required.

## Keys

| Setup | What you need | What you get |
|---|---|---|
| OpenRouter (recommended) | one `OPENROUTER_API_KEY` | both brains: Jev as `typesafe/jev-1.13`, the LLM as `anthropic/claude-opus-5` |
| TypeSafe + Anthropic | `TYPESAFE_API_KEY`, optionally `ANTHROPIC_API_KEY` | native Jev; without the Anthropic key the slow brain falls back to mock |
| Mock | nothing | a keyword-overlap stand-in for Jev and a comma-splitting stand-in for the LLM |

One OpenRouter key is the short path because it reaches both brains. In the popup, pick the provider
and paste the key; keys are stored in `chrome.storage.local` and never leave your browser except as
`Authorization` headers to that provider. Changing the provider or a key clears the verdict cache, so
a probability from one provider is never served as if it came from another.

For the CLI, set the same variables in your shell or in a `.env` file at the repo root. Shell
variables win over `.env`. With no key and no flags, the CLI uses mock providers and says so on
stderr.

## Using it

1. Click the jev-duo icon. Write your intent in the box, for example
   `Hide crypto shilling and ragebait. Keep anything about Rust.`
2. Press **Compile**. The popup lists every compiled rule as `glyph · label · statement · threshold`,
   so you can see exactly what the fast brain will be asked.
3. Browse. Folded posts collapse to one line: `⚡ <label> <percentage>`, with **Show** and **Wrong**.
   Dimmed posts drop to 35% opacity with a tag. Badged posts only get the tag. Kept-by-rule posts get
   a `★ kept: <label>` tag.
4. Correct it. **Wrong** on a fold, or the `hide this` affordance that appears on hover over a kept
   post, records an example. After 10 examples the extension recompiles the pack on its own; the
   popup's **Recompile from feedback** button does it immediately.
5. Tune with the **Strictness** slider. It offsets every threshold at decision time (clamped to
   [0.5, 0.95]) without editing the stored pack. Per-site toggles and a stats panel (judged, folded,
   kept by rule, errors, p50 latency, estimated cost) are in the same popup.

## CLI

```
$ jev-duo --help
jev-duo 0.1.0
A two-brain agent that reads your feeds with you: an LLM writes the rules,
Jev enforces them at 100ms per post.

Usage:
  jev-duo <command> [options]

Commands:
  hn        Judge the Hacker News front page with your rules
  compile   Turn a plain-English intent into a question pack
  judge     Judge JSONL items (file or stdin) against a pack
  demo      Run "hn" with mock providers and a built-in intent (no keys)
```

```bash
# 1. hn: judge the live front page with an intent
jev-duo hn --rules "Hide crypto and AI hype. Keep anything about databases." --limit 20

# 2. compile: turn an intent into a reusable pack
jev-duo compile "Hide crypto shilling and ragebait. Keep anything about Rust." --out pack.json

# 3. judge: run a pack over JSONL items from a file or stdin
jev-duo judge --pack pack.json --input items.jsonl --json

# 4. demo: the whole loop with no keys at all
jev-duo demo
```

`--provider mock|openrouter|typesafe` picks the fast brain and `--llm mock|openrouter|anthropic`
picks the slow one; they resolve independently, so `--provider mock --llm openrouter` is a valid
pair. Without flags, each is chosen from whichever keys are present. Exit codes: `0` success,
`1` usage error, `2` provider error after retries.

A real `jev-duo demo` run (first 12 lines and the footer; it fetches the live front page, so your
output will differ):

```
jev-duo demo — mock providers, Hacker News front page
 1 ✓                Exfiltrate Your Weights
 2 ✓                Qwen Image 2.1
 3 ★                AX – Google’s Open Agentic Orchestrator
 4 ✓                What happened to the Snowden archive
 5 ✓                Samsung is expected to more than double output of its HBM4 and HBM4E DRAM
 6 ✓                Spain orders blocks on Archive.today and its mirrors
 7 ✓                ZuckOff Know when a camera is in the room
 8 ✓                I am often wrong
 9 ✓                Singapore’s National Library Board offers micropayments to build reading habits
10 ✓                The Effect of CRTs on Pixel Art (2024)
11 ✓                Grim Fandango Puzzle Document (1996) [pdf]
12 ★                Sherline Tools Is Going Out of Business
...
judged 30 · folded 0 · dimmed 0 · kept 30 · errors 0 · p50 0ms · ~$0.0002
```

`✓` is a plain keep, `★` a keep forced by a keep-rule, `⚡` a fold, `◐` a dim, `◦` a badge. The demo
uses the mock fast brain, which scores by keyword overlap rather than by reading, so it folds far
less than real Jev would. Point it at a real key to see the difference.

## Writing good intents

The compiler prompt turns your sentence into questions a model must answer from the post text alone.
Five things that make its job easier:

1. **Describe what is visible in the post.** "This post is primarily promoting a token to buy" is
   answerable; "this post is low quality" is not.
2. **One idea per clause.** The compiler splits every "X or Y" into two rules anyway. Splitting them
   yourself means you decide where the seam goes.
3. **Say your exceptions out loud.** Clauses like "keep", "always show" and "but keep" become keep
   rules, and a keep rule overrides every hide rule on the same post.
4. **Your wording sets the threshold.** Absolute phrasing ("never", "no crypto at all") compiles to
   0.6, soft phrasing ("less", "fewer", "not so much") to 0.8, anything else to the default 0.7.
5. **Say how you want it hidden.** "dim" or "fade" compiles to a dim action, "label", "tag" or "flag"
   to a badge. Everything else folds.

## How the two brains split the work

| Task | Brain | Why there |
|---|---|---|
| Compile an intent into a question pack | System 2 (LLM) | Writing well-posed, independent questions is deliberate work. Done once per intent. |
| Judge every post in the feed | System 1 (Jev) | Roughly 100 ms per post and $0.042 per million input tokens, output free. Thousands of small typed judgments a day. |
| Second opinion in the gray zone | System 2 (LLM) | Only when a probability lands inside a rule's ambiguous band. Budgeted to 20 calls per 10 minutes per surface; over budget the post stays visible. |
| Learn from your corrections | System 2 (LLM) | A recompile with up to 40 recent examples, asked for the smallest rewording that fixes them. |

## Privacy

- **No backend.** There is no jev-duo server. The extension and the CLI talk to your providers
  directly.
- **Keys stay local.** In the extension they live in `chrome.storage.local`; in the CLI they come
  from the environment or a `.env` file you own.
- **Post text goes to exactly one place:** the provider you configured. In mock mode nothing leaves
  the machine at all.
- **Every API call leaves from the extension's service worker.** The native TypeSafe API rejects
  browser-page CORS (an `OPTIONS` from an arbitrary origin returns `400 Disallowed CORS origin`),
  and a service worker with host permissions is exempt. Content scripts never hold a key or call a
  provider; they only exchange typed messages with the worker.
- **Nothing is logged or sent anywhere else.** Counters, the compiled pack and your examples sit in
  `chrome.storage.local`; the verdict cache sits in `chrome.storage.session` and dies with the
  browser session.
- **Permissions are `storage` plus host permissions** for the three sites and the three API origins.
  No `tabs`, no `history`.

## Status & known limits

- **Not verified against live Jev in CI.** The `@live-jev` tests exist and skip themselves when no
  key is present, which is what happens in CI. To run them yourself, put `OPENROUTER_API_KEY` or
  `TYPESAFE_API_KEY` in `.env` and run `LIVE=1 pnpm test:e2e`. `LIVE=1` also enables a test that
  judges the real news.ycombinator.com, so it needs network.
- **X changes its DOM.** Every selector lives inside `src/extension/adapters`, is documented in
  `src/extension/adapters/README.md`, and is covered by the fixtures in `tests/e2e/fixtures`. When a
  site changes, one adapter and one fixture change together. If an adapter finds nothing, the popup
  reports zero posts seen rather than failing silently.
- **English first.** The compiler prompt and the mock compiler both assume English intents.
- **v1 uses Noul questions only.** Jev's Choice and Score primitives are implemented in the provider
  layer but no v1 feature needs them, so nothing sorts or scores your feed yet.
- **The arbiter is budgeted.** 20 calls per 10 minutes per surface. Past that, ambiguous posts are
  kept rather than escalated.
- **The service worker bundle is about 1.3 MB**, almost all of it the Anthropic SDK. It loads fine,
  but it is the obvious thing to shrink next.

## Development

```bash
pnpm install
pnpm check        # typecheck + unit tests + build
pnpm test:e2e     # Playwright, headless, loads the real built extension
```

| Script | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over `src` and `tests` |
| `pnpm test` | vitest unit suite |
| `pnpm build` | esbuild bundles `dist/cli` and `dist/extension` |
| `pnpm test:e2e` | Playwright: extension over the X/Reddit/HN fixtures, plus the built CLI |
| `pnpm test:e2e:live` | the same with `LIVE=1`, adding the live HN and live Jev tests |
| `pnpm package:ext` | zips `dist/extension` into `jev-duo-extension.zip` |
| `pnpm check` | typecheck, unit tests and build in one go (the same three steps CI runs before e2e) |

```
src/core/          types, policy, evaluator, compiler, arbiter, learner, prompts, providers/
src/cli/           index.ts, commands/, sources/hn.ts, render.ts
src/extension/     manifest.json, background.ts, content.ts, adapters/, ui/, popup/
tests/unit/        mirrors src
tests/e2e/         extension.spec.ts, cli.spec.ts, fixtures/, server.ts
scripts/           build.mjs, package-extension.mjs, make-icons.mjs
docs/superpowers/  specs/, plans/, research/
```

The design spec is `docs/superpowers/specs/2026-09-20-jev-duo-design.md`, the implementation plan is
`docs/superpowers/plans/2026-09-20-jev-duo.md`, and the provider and selector research the client
code was written from is in `docs/superpowers/research/`. See `CONTRIBUTING.md` before opening a PR.

## License

MIT. See `LICENSE`.
