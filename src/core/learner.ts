import { AUTO_RECOMPILE_EVERY, EXAMPLES_MAX } from './constants';
import type { Example } from './types';

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Structural check only (not a full schema) — enough to reject garbage without duplicating schema.ts's validation. */
function isExample(x: unknown): x is Example {
  if (!isPlainObject(x)) return false;
  const item = x.item;
  const decision = x.actualDecision;
  return (
    isPlainObject(item) && typeof item.id === 'string' && typeof item.text === 'string' &&
    (x.expected === 'show' || x.expected === 'hide') &&
    isPlainObject(decision) && typeof decision.kind === 'string' &&
    (x.source === 'user' || x.source === 'arbiter') && typeof x.at === 'string'
  );
}

export interface ExampleStoreJSON { examples: Example[]; sinceRecompile: number }

/** Ring buffer of user/arbiter corrections, feeding recompiles. Only `source: 'user'` examples count toward the auto-recompile trigger. */
export class ExampleStore {
  private items: Example[] = [];
  private sinceRecompileCount = 0;

  constructor(private readonly max: number = EXAMPLES_MAX, private readonly autoEvery: number = AUTO_RECOMPILE_EVERY) {}

  add(ex: Example): void {
    this.items.push(ex);
    if (this.items.length > this.max) this.items.shift();
    if (ex.source === 'user') this.sinceRecompileCount += 1;
  }

  list(): Example[] { return [...this.items]; }

  get size(): number { return this.items.length; }
  get userCount(): number { return this.items.filter((e) => e.source === 'user').length; }
  get sinceRecompile(): number { return this.sinceRecompileCount; }

  shouldAutoRecompile(): boolean { return this.sinceRecompileCount >= this.autoEvery; }
  markRecompiled(): void { this.sinceRecompileCount = 0; }

  toJSON(): ExampleStoreJSON { return { examples: this.list(), sinceRecompile: this.sinceRecompileCount }; }

  static fromJSON(j: unknown, max: number = EXAMPLES_MAX, autoEvery: number = AUTO_RECOMPILE_EVERY): ExampleStore {
    const store = new ExampleStore(max, autoEvery);
    if (!isPlainObject(j)) return store;
    const examples = j.examples;
    if (!Array.isArray(examples)) return store;
    store.items = examples.filter(isExample).slice(-max);
    const since = j.sinceRecompile;
    store.sinceRecompileCount = typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : 0;
    return store;
  }
}
