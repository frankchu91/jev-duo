import { VERSION } from '../core/index.js';

export const NO_KEY_NOTE = 'note: no API key found, using mock providers (set OPENROUTER_API_KEY for real judgments)\n';

export const USAGE = `jev-duo ${VERSION}
A two-brain agent that reads your feeds with you: an LLM writes the rules,
Jev enforces them at 100ms per post.

Usage:
  jev-duo <command> [options]

Commands:
  hn        Judge the Hacker News front page with your rules
  compile   Turn a plain-English intent into a question pack
  judge     Judge JSONL items (file or stdin) against a pack
  demo      Run "hn" with mock providers and a built-in intent (no keys)

jev-duo hn [options]
  --pack <file>          Question pack JSON to judge with
  --rules <intent>       Plain-English intent to compile into a pack (alternative to --pack)
  --limit <n>            Number of front-page posts to fetch (default 30)
  --provider <mode>      Jev provider: mock | openrouter | typesafe
  --llm <mode>           LLM provider: mock | openrouter | anthropic
  --strictness <0..1>    Decision threshold strictness (default 0.5)
  --json                 Print one JSON verdict per line instead of a table

jev-duo compile "<intent>" [options]
  --rules <intent>        Intent, as an alternative to the positional argument
  --with-feedback <file>  JSONL of past Example corrections to fold into the prompt
  --out <file>            Write the compiled pack JSON here instead of stdout
  --provider <mode>       Jev provider: mock | openrouter | typesafe
  --llm <mode>            LLM provider: mock | openrouter | anthropic

jev-duo judge --pack <file> [options]
  --pack <file>          Question pack JSON to judge with (required)
  --input <file>         JSONL of Items to judge (default: read from stdin)
  --provider <mode>      Jev provider: mock | openrouter | typesafe
  --llm <mode>           LLM provider: mock | openrouter | anthropic
  --strictness <0..1>    Decision threshold strictness (default 0.5)
  --json                 Print one JSON verdict per line instead of a table

jev-duo demo
  Judges the live Hacker News front page with mock providers and a built-in
  demo intent. Requires no API keys.

Options:
  -h, --help      Show this help
  -v, --version   Print the version`;
