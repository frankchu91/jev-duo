# jev-duo — design spec

Date: 2026-09-20
Status: approved for implementation (owner delegated all design decisions)
Repo: github.com/frankchu91/jev-duo

## 1. What jev-duo is

jev-duo is a two-brain agent that reads your feeds with you.

You tell it, in plain English, what you do not want to see and what you
always want to keep. A slow, deliberate brain (an LLM, "System 2") turns
that sentence into a pack of typed questions. A fast, reflexive brain
(TypeSafe's Jev, "System 1") answers those questions for every post that
scrolls into view, in roughly 100 ms and for a fraction of a cent per
thousand posts. The agent folds what you would have skipped anyway,
badges why, and learns from every "wrong" click.

The name is the architecture. "Duo" is not decoration: System 2 writes
the rules, System 1 enforces them, System 2 is called back only for the
gray zone and for learning.

Two surfaces share one core:

- A Chrome extension (Manifest V3) for x.com, reddit.com and
  news.ycombinator.com.
- A CLI (`jev-duo`) that runs the same rules over Hacker News from the
  terminal, judges arbitrary JSONL, and prints compiled question packs.

## 2. Why this shape (the reflection behind the decisions)

**Why a filter and not a task agent.** The Jev ecosystem after five days
holds 155+ catalogued projects. Browser task agents are owned by
browser-use's jev-ultrafast (13k stars). Coding-agent plumbing (routers,
compaction, review hooks) is saturated. The one category with proven
audience and almost no entries is consumer-side content tools: 444
"tools and demos" posts versus 8 "content and growth" posts, while a
single live "BS meter" post drew 175k views. The consumption side of
feeds (what you scroll) has zero Jev projects; the two that exist score
your own drafts.

**Why Jev is the right brain for this.** A feed is thousands of small,
independent, typed judgments per day. That is exactly the workload Jev
was built for and exactly the workload an LLM cannot afford: 2,000 posts
a day is under two cents on Jev and tens of dollars, at two seconds
each, on an LLM. Jev cannot write a sentence, and this product never
needs one at judgment time.

**Why an LLM is still required.** Jev answers questions; it does not
invent them. "Hide ragebait" is not a question. Turning intent into
well-posed, independent, calibrated statements is deliberate work, done
once. Refining those statements from a user's corrections is deliberate
work, done rarely. Both are System 2 jobs.

**Why fail-open.** The agent hides content. Every error path must leave
content visible. A filter that hides on error is worse than no filter.

**Why no backend.** Keys stay in the user's browser or shell. Calls go
straight from the extension's service worker (or the CLI process) to the
providers. Nothing to host, nothing to trust.

**Why OpenRouter is the default path.** One key reaches both brains
(Jev is listed there as `typesafe/jev-1.13`; any LLM is a model id
away). Native TypeSafe plus Anthropic is supported for people who
already hold those keys.

**Why Noul only in v1.** A hide rule is a statement with a calibrated
probability. Noul returns exactly that. Choice and Score are supported
by the client layer but no v1 feature needs them. YAGNI.

## 3. The loop

```
intent (plain English)
   │  System 2: compile
   ▼
QuestionPack  ──────────────────────────────────────────────────┐
   │                                                             │
items (DOM / HN API) ── System 1: judge (Jev, per item) ──▶ verdicts
   │                                                             │
   │                          policy: thresholds, keeps override hides
   ▼                                                             │
actions: fold / dim / badge / keep ◀─────────────────────────────┘
   │
   ├── gray zone (p inside ambiguous band, no decisive rule)
   │        └── System 2: arbiter (LLM, budgeted) ──▶ override + example
   │
   └── user feedback ("wrong", "hide this") ──▶ examples
                                                   └── System 2: recompile
```

Every arrow is a pure function or a provider call with a mock. Every
box is testable alone.

## 4. Core domain model (`src/core`)

```ts
type Platform = 'x' | 'reddit' | 'hn' | 'generic';

interface Item {
  id: string;            // stable per platform (tweet id, post id, hn id) or content hash
  platform: Platform;
  author?: string;
  text: string;          // primary text; title + body for reddit/hn
  url?: string;
  meta?: {
    hasLink?: boolean; hasMedia?: boolean; isReply?: boolean;
    isPromoted?: boolean; score?: number; comments?: number;
  };
}

type Action = 'fold' | 'dim' | 'badge';

interface Rule {
  id: string;            // slug, unique in pack
  label: string;         // badge text, <= 24 chars
  question: string;      // a Noul statement about "this post"
  threshold: number;     // act when p >= threshold (default 0.7)
  action: Action;        // hide rules only
  ambiguous: [number, number]; // arbiter band, default [0.45, threshold)
}

interface KeepRule {
  id: string; label: string; question: string; threshold: number; // default 0.6
}

interface QuestionPack {
  version: 1;
  intent: string;
  compiledAt: string;
  compiledBy: string;    // llm model id or "mock"
  rules: Rule[];         // hide rules
  keeps: KeepRule[];     // exceptions; a keep hit overrides every hide
  notes?: string;        // one-paragraph interpretation shown in the popup
}

interface RuleVerdict { ruleId: string; p: number; }

interface Verdict {
  itemId: string;
  rules: RuleVerdict[];
  keeps: RuleVerdict[];
  decision: Decision;
  latencyMs: number;
  source: 'jev' | 'cache' | 'arbiter' | 'error';
  error?: string;
}

type Decision =
  | { kind: 'keep'; reason?: string }                  // reason = keep label if a keep fired
  | { kind: 'fold' | 'dim' | 'badge'; ruleId: string; label: string; p: number }
  | { kind: 'pending-arbiter'; ruleId: string; p: number };

interface Example {
  item: Item;
  expected: 'show' | 'hide';
  actualDecision: Decision;
  source: 'user' | 'arbiter';
  at: string;
}
```

### 4.1 Policy (pure)

`decide(pack, ruleVerdicts, keepVerdicts): Decision`

1. If any keep has `p >= keep.threshold`, return `keep` with that label.
2. Collect hide rules with `p >= rule.threshold`; if any, pick the highest
   `p`, return its action with label and p.
3. Collect hide rules with `p` inside `ambiguous`; if any, return
   `pending-arbiter` for the highest.
4. Else `keep`.

Global strictness (popup slider, CLI `--strictness`) is applied as an
offset to every threshold at decide time, clamped to [0.5, 0.95]. Packs
are stored unmodified.

### 4.2 Jev state

One request per item. State is a JSON object:

```json
{ "platform": "x", "author": "@handle", "text": "...", "hasLink": true,
  "hasMedia": false, "isReply": false, "isPromoted": false }
```

Questions in the request: all pack rules and keeps as Noul statements,
evaluated in parallel by Jev in one call. Question text is prefixed with
nothing; the compiler is responsible for writing statements that refer
to "this post".

Text is truncated to 2,000 characters before sending (Jev context is 32K
tokens; a post never needs more).

### 4.3 Evaluator

`Evaluator.judge(items: Item[]): Promise<Verdict[]>`

- LRU cache keyed by `sha256(pack.compiledAt + item.id + item.text)`,
  size 5,000 in memory; the extension mirrors it in
  `chrome.storage.session`.
- Concurrency 6, FIFO queue, per-item timeout 10 s.
- Retries: 2 with exponential backoff on 429 and 5xx; none on 4xx.
- Any failure yields `source: 'error'`, `decision: keep`. Fail-open.
- Emits per-verdict callbacks so the UI updates item by item rather
  than per batch.

### 4.4 Compiler (System 2)

`compile(intent, llm, examples?): Promise<QuestionPack>`

Prompt contract (fixed, versioned in `prompts.ts`):

- Split the intent into independent hide rules and keep rules.
- Each rule becomes one Noul statement about "this post", phrased so a
  reader with only the post text could answer it. No compound
  statements ("X or Y" becomes two rules). No reasoning words.
- Labels are 1 to 3 words. Thresholds default 0.7 (hide) and 0.6 (keep);
  the LLM may lower a threshold to 0.6 for rules the user phrased as
  strict ("never show me") and raise to 0.8 for rules phrased softly.
- Output strictly as JSON matching a schema; the client validates with
  zod and retries once with the validation error appended.
- When examples are supplied (recompile), the prompt lists up to 40
  most recent examples as `{text, expected, whatFired}` and asks for
  targeted rewording, not wholesale change; rule ids are preserved when
  meaning is preserved.

The mock LLM produces a deterministic pack from the intent by splitting
on commas, "and", and sentence boundaries, and treating clauses that
start with "keep", "always show", "but keep" as keeps. This is what
tests and key-less demos use.

### 4.5 Arbiter (System 2, budgeted)

`arbitrate(item, pack, verdict, llm): Promise<Decision>`

Called only for `pending-arbiter`. Sends the post and the rule
statements, asks for JSON `{ hide: boolean, ruleId?: string, why: string }`.
Budget: at most 20 calls per 10 minutes per surface; over budget the
item stays `keep`. Result overrides the decision and is recorded as an
`Example` with `source: 'arbiter'`. Off by default in the CLI, on by
default in the extension when an LLM key is present.

### 4.6 Learner

- Ring buffer of 200 examples in storage.
- `recompile()` = `compile(intent, llm, examples)`.
- Extension auto-recompiles after every 10 user examples; the popup
  also has a button. The CLI exposes `jev-duo compile --with-feedback`.

### 4.7 Providers

Interfaces:

```ts
interface JevProvider {
  evaluate(req: JevRequest): Promise<JevResponse>;  // shape from TypeSafe docs, see §7
  name: string;
}
interface LlmProvider {
  completeJson(system: string, user: string, opts?: {maxTokens?: number}): Promise<string>;
  name: string;
}
```

Jev: `typesafe` (native HTTP), `openrouter`, `mock`.
LLM: `anthropic` (Messages API, `claude-sonnet-5` default, browser header
set in the extension), `openrouter` (chat completions, default model
`anthropic/claude-sonnet-5`), `mock`.

Mock Jev scores each question by a transparent heuristic: keyword hits
between the question and the item text, weighted, squashed to [0,1],
plus a seeded jitter so distributions look real. It also honours a
fixture map (`itemId -> {ruleId: p}`) when supplied, which the e2e tests
use for exact expectations.

## 5. Chrome extension (`src/extension`)

Manifest V3. Permissions: `storage`, host permissions for the three
sites and the provider API origins. No `tabs`, no `history`.

### 5.1 Components

- `background.ts` (service worker): owns one `DuoAgent`. Handles
  messages: `judge(items[])`, `compile(intent)`, `feedback(example)`,
  `getState()`, `setSettings(partial)`, `recompile()`. Persists settings,
  keys, pack and examples in `chrome.storage.local`; verdict cache in
  `chrome.storage.session`.
- `content.ts`: selects an adapter by hostname; injects CSS; runs a
  `MutationObserver` on `document.body`; debounces new post elements
  (150 ms, max batch 10); marks them `data-jd="pending"`; sends `judge`;
  applies each verdict through the adapter as it arrives.
- `adapters/{x,reddit,hn}.ts`, each implementing:

```ts
interface Adapter {
  platform: Platform;
  matches(url: URL): boolean;
  findPosts(root: ParentNode): Element[];   // idempotent, returns unseen + seen
  extract(el: Element): Item | null;        // null = not a judgeable post (e.g. placeholder)
  mount(el: Element, decision: Decision, handlers: FoldHandlers): void;
}
```

- `ui/fold.ts`: the shared fold bar. A folded post collapses to one
  line: lightning glyph, label, percentage, `Show`, `Wrong`. `Show`
  expands without feedback. `Wrong` expands and posts an `Example`
  (`expected: 'show'`). Every kept post gets a hidden-until-hover
  `Hide this` affordance that posts `expected: 'hide'`. Dimmed posts get
  opacity 0.35 and a tag. Badged posts get only the tag.
- `popup/`: rules textarea and `Compile` button; the compiled pack
  rendered as a list of `label — statement — threshold`; provider
  selector with key fields; strictness slider; per-site toggles; stats
  (judged, folded, kept-by-rule, estimated cost, p50 latency); example
  count and `Recompile from feedback`; `Mock mode` switch that needs no
  keys.

### 5.2 Pending state

Posts are dimmed to opacity 0.6 while pending, restored on `keep`,
folded or dimmed on a hide decision. A post that errors is restored
immediately. Pending never lasts past the 10 s timeout.

### 5.3 Site notes

Selectors live only inside adapters and are covered by fixture tests.
X: `article[data-testid="tweet"]`, text from `[data-testid="tweetText"]`,
author from `[data-testid="User-Name"]`, promoted detection via the
"Ad" / "Promoted" marker text. Reddit: `shreddit-post` with its
`post-title` and text-body slot. HN: `tr.athing` rows plus their
`.subtext` sibling; the fold collapses both rows. Exact selectors are
confirmed against fixtures captured at build time and documented in
`src/extension/adapters/README.md`.

## 6. CLI (`src/cli`)

Package bin `jev-duo`.

- `jev-duo hn [--rules "<intent>" | --pack pack.json] [--limit 30] [--provider mock|openrouter|typesafe] [--llm mock|openrouter|anthropic] [--strictness 0.7] [--json]`
  Fetches the Hacker News front page (Algolia `search?tags=front_page`),
  judges every story, prints a table: rank, decision glyph, label and
  percentage, title. Folded stories are printed dimmed on one line.
  `--json` prints verdicts as JSONL.
- `jev-duo compile "<intent>" [--out pack.json] [--with-feedback examples.jsonl]`
- `jev-duo judge --pack pack.json [--input items.jsonl] [--json]`
  Reads items from a file or stdin.
- `jev-duo demo` = `hn --provider mock --llm mock --rules "<built-in demo intent>"`.

Keys from env: `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`,
`ANTHROPIC_API_KEY`. With no key and no `--provider`, the CLI uses mock
providers and prints one line saying so.

Exit codes: 0 success, 1 usage error, 2 provider error after retries.

## 7. Provider wire formats

Filled from the TypeSafe documentation research (see
`docs/superpowers/research/typesafe-api.md`). The client code and its
contract tests are derived from that file, not from memory. If the
research marks a field UNVERIFIED, the client treats it as optional and
the README says so.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| No key for chosen provider | Popup shows inline error; content script does nothing; CLI exits 1 with a one-line hint |
| Jev 4xx | Verdict `error`, item kept, popup error counter increments |
| Jev 429/5xx | 2 retries with backoff, then as 4xx |
| LLM returns invalid JSON | One retry with validation error appended, then compile fails visibly; previous pack stays active |
| Adapter cannot extract | Element skipped, no pending state applied |
| Site DOM changed | Adapter finds zero posts; popup shows "0 posts seen on this page" so the failure is visible |

## 9. Testing strategy

- Unit (vitest): policy, compiler with mock LLM, schema validation,
  evaluator (cache, concurrency, timeout, fail-open), providers
  (request shape asserted against the documented wire format with a
  stubbed `fetch`), adapters (jsdom over fixture HTML), learner, CLI
  output formatting.
- Extension e2e (Playwright, persistent context, unpacked extension):
  fixture X page and fixture Reddit page served from a local static
  server; live news.ycombinator.com. Mock Jev with a fixture map so
  expectations are exact: given items are folded with the right label,
  `Wrong` records an example, popup shows counts.
- CLI e2e: `jev-duo demo` against live Algolia; `jev-duo judge` on a
  fixture JSONL offline; `jev-duo compile` with mock LLM.
- Live smoke (opt-in, `LIVE=1` plus keys): compile a real pack with the
  configured LLM, judge 5 fixture items with real Jev, assert schemas
  and that probabilities are in [0,1]. Not part of CI.

Definition of "usable": all unit and e2e suites green, the extension
loads unpacked in Chrome with zero manifest warnings, `jev-duo demo`
prints a judged front page without keys, and with an OpenRouter key the
live smoke passes.

## 10. Non-goals for v1

YouTube segment skipping, Gmail, Slack, sorting by interest (Score),
cross-device sync, a hosted backend, Firefox packaging, Chinese
language tuning, any text generation.

## 11. Repository layout

```
jev-duo/
  package.json  pnpm-lock.yaml  tsconfig.json  vitest.config.ts  playwright.config.ts
  src/core/            types, policy, evaluator, compiler, arbiter, learner, duo, prompts, providers/
  src/cli/             index.ts, commands/, sources/hn.ts, render.ts
  src/extension/       manifest.json, background.ts, content.ts, adapters/, ui/, popup/, styles.css
  tests/unit/          mirrors src
  tests/e2e/           extension.spec.ts, cli.spec.ts, fixtures/, server.ts
  scripts/             build-extension.ts (esbuild), package-extension.ts (zip)
  docs/superpowers/    specs/, plans/, research/
  README.md  LICENSE (MIT)  .github/workflows/ci.yml
```
