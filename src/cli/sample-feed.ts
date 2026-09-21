import type { Item } from '../core/index.js';

/** The feed `jev-duo demo` judges when it is not asked for `--live`: eight short posts that between
 * them hit every branch of the built-in demo intent (two crypto shills, political outrage, layoffs
 * drama, a product launch to dim, and three posts it should leave alone). Identical to
 * `tests/e2e/fixtures/items.jsonl`, which the offline `judge` tests use, so the two stay comparable —
 * bundling it is what lets the demo run with no network and no keys at all. */
export const SAMPLE_FEED: Item[] = [
  { id: 'fx:1', platform: 'generic', text: 'New DogeMoon token launch today, buy the presale now before it moons, crypto gem 100x pump guaranteed' },
  { id: 'fx:2', platform: 'generic', text: 'Bitcoin ICO airdrop is live, join our crypto token launch, staking rewards and moon soon, buy the dip' },
  { id: 'fx:3', platform: 'generic', text: 'Political outrage erupts as politicians trade furious insults in a partisan shouting match over the vote' },
  { id: 'fx:4', platform: 'generic', text: 'Company announces massive layoffs, thousands of employees laid off in a brutal workforce reduction' },
  { id: 'fx:5', platform: 'generic', text: 'We are thrilled to announce the launch of our new product today, available now for everyone' },
  { id: 'fx:6', platform: 'generic', text: 'Rust 1.90 released with new async traits and improved compiler diagnostics for embedded systems' },
  { id: 'fx:7', platform: 'generic', text: 'A deep dive into how modern databases handle query planning, indexing, and replication in PostgreSQL 17' },
  { id: 'fx:8', platform: 'generic', text: 'A simple recipe for weeknight pasta with garlic, olive oil, and fresh basil from the garden' },
];
