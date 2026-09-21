import { VERSION } from '../core/index.js';

const USAGE = `jev-duo ${VERSION}
A two-brain agent that reads your feeds with you: an LLM writes the rules,
Jev enforces them at 100ms per post.

Usage:
  jev-duo <command> [options]

Commands:
  hn        Judge the Hacker News front page with your rules
  compile   Turn a plain-English intent into a question pack
  judge     Judge JSONL items (file or stdin) against a pack
  demo      Run "hn" with mock providers and a built-in intent (no keys)

Options:
  -h, --help      Show this help
  -v, --version   Print the version

Commands are not implemented yet; this is a scaffold.`;

function main(argv: string[]): number {
  const [first] = argv;

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return 0;
  }

  if (first === undefined || first === '--help' || first === '-h') {
    console.log(USAGE);
    return 0;
  }

  console.error(`jev-duo: unknown command "${first}" (try --help)`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
