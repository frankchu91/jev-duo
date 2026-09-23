# Contributing to jev-duo

Thanks for looking. This is a small, opinionated codebase; the rules below keep it that way.

## Setup

```bash
pnpm install
pnpm build            # dist/cli and dist/extension
```

Node 20 or newer, pnpm 10.

## Running the suites

```bash
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest unit suite
pnpm check            # typecheck + test + build, what CI runs first
pnpm test:e2e         # Playwright, headless, against the built dist/extension
LIVE=1 pnpm test:e2e  # adds the tests that need network and real keys
```

`pnpm test:e2e` requires a build first, because it loads `dist/extension` unpacked and runs
`dist/cli/index.js` as a subprocess. Install browsers once with
`pnpm exec playwright install --with-deps chromium`.

The `LIVE=1` tests are opt-in and never run in CI. The live Hacker News tests need the public
internet; the `@live-jev` tests additionally need `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`, which
the CLI and the e2e suite both read from a `.env` file at the repo root. They skip themselves, with a
message, when the key is missing.

## Test-driven, please

Write the failing test first, then the code that makes it pass. Every module in `src/core` is a pure
function or a provider call with a mock behind it, and that is deliberate: it means a behaviour
change should be expressible as a test before it is expressible as a diff. A PR that changes
behaviour without changing or adding a test will be asked for one.

Fail-open is a behaviour, not an accident. If you touch the evaluator, the providers or the content
script, keep the property that any error, timeout or budget exhaustion leaves the post visible, and
keep the test that proves it.

## Adapters and fixtures

Site selectors live in exactly one place: `src/extension/adapters/{x,reddit,hn}.ts`. Nothing outside
an adapter may query a site's markup.

If you change a selector:

1. Update the adapter.
2. Update the matching fixture in `tests/e2e/fixtures/{x,reddit,hn}.html` so it reflects the real
   markup you saw.
3. Update the selector table in `src/extension/adapters/README.md`, including where the new markup
   came from and when you captured it.

All three move together. A selector change with no fixture change is not reviewable, because nothing
proves the new selector matches anything real.

`adapters/generic.ts` is the fallback for every other site and has no selectors at all: it finds a
feed by structural repetition (design addendum `2026-09-21-generic-sites-design.md` §3). The same
rule applies to it — tune the heuristic and `tests/e2e/fixtures/generic.html` moves with it, because
that Mastodon-like fixture is what proves the tuning still recognises a real feed.

Reading mode has two fixtures of its own. `tests/e2e/fixtures/article.html` is an arXiv-like paper
with exactly 21 qualifying passages, and every shape that must *not* become one around them (a nav
blurb, a figure, three hidden paragraphs, a bibliography of `li`, a footer); change the extraction
rules in `src/extension/reading/article.ts` and that fixture moves with them, because the passage
count is what proves the rules still recognise a document. `tests/e2e/fixtures/sample.pdf` is
committed and written by `pnpm fixtures:pdf` (`tests/e2e/fixtures/make-sample-pdf.mjs`), which is
deterministic — regenerate it rather than editing the bytes, and commit the result.

## Commits

One logical change per commit. Subject line in the imperative mood with a conventional-commit
prefix, lowercase, no trailing period:

```
feat(extension): popup
fix(cli): exit 2 on provider failure after retries
test(e2e): extension fixtures, popup, cli
docs: readme, contributing, package metadata
```

Use the body to explain why, not what. Keep `pnpm check` green in every commit, not just at the end
of a branch.

## Design docs

`docs/superpowers/` is the written record of the project:

- `specs/` holds the design spec. It is the contract the code is written against.
- `plans/` holds the implementation plan, task by task.
- `research/` holds the provider and selector research the client code was derived from, with
  sources and capture dates. Client behaviour is written from these files rather than from memory,
  so if you find them wrong, fix the research file in the same PR.

If a change contradicts the spec, say so in the PR description and update the spec in the same
change.
