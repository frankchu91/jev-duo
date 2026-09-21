import { Arbiter } from './arbiter';
import { LruCache } from './cache';
import { compile as compilePack } from './compiler';
import { CACHE_SIZE, DEFAULT_STRICTNESS, JEV_INPUT_USD_PER_MTOK } from './constants';
import { Evaluator, type VerdictListener } from './evaluator';
import { ExampleStore } from './learner';
import { ProviderError, type JevProvider, type JevRequest, type LlmProvider } from './providers/types';
import type { Example, Item, QuestionPack, Verdict, VerdictSource } from './types';

export interface DuoSettings {
  strictness: number;
  arbiter: boolean;
}

export interface DuoStats {
  judged: number; folded: number; dimmed: number; badged: number; kept: number; keptByRule: number;
  errors: number; cacheHits: number; arbitrated: number; p50LatencyMs: number; estimatedUsd: number;
  inputTokens: number; lastSources: VerdictSource[];
}

export interface DuoAgentOptions {
  jev: JevProvider; llm: LlmProvider; pack?: QuestionPack; settings?: Partial<DuoSettings>;
  examples?: ExampleStore; cache?: LruCache<Verdict>; arbiter?: Arbiter; now?: () => Date;
}

const LAST_LATENCIES_MAX = 200;
const LAST_SOURCES_MAX = 50;

/** Fallback token estimate for a Jev call that reported no `usage`: ~4 chars/token over state + questions. */
function estimateInputTokens(req: JevRequest): number {
  const stateChars = JSON.stringify(req.state).length;
  const questionChars = req.questions.reduce((sum, q) => sum + (q.type === 'noul' ? q.statement.length : q.question.length), 0);
  return Math.ceil(stateChars / 4) + Math.ceil(questionChars / 4);
}

/** Wraps `jev` so DuoAgent can recover per-item token usage for stats: `Verdict` (fixed by an earlier
 * task) carries no usage field, so this is the only place that ever sees the raw `JevResponse.usage`. */
function tapUsage(jev: JevProvider, sink: Map<string, number>): JevProvider {
  return {
    name: jev.name,
    async evaluate(req: JevRequest, signal?: AbortSignal) {
      const res = await jev.evaluate(req, signal);
      if (req.meta?.itemId !== undefined) sink.set(req.meta.itemId, res.usage?.inputTokens ?? estimateInputTokens(req));
      return res;
    },
  };
}

/** Single facade over the evaluator (fast brain) and arbiter (slow brain) that the CLI and the
 * Chrome extension both call. Owns settings, the example store and running stats. */
export class DuoAgent {
  private _pack: QuestionPack | undefined;
  private _settings: DuoSettings;
  private readonly llm: LlmProvider;
  private readonly evaluator: Evaluator;
  private readonly arbiter: Arbiter;
  private readonly exampleStore: ExampleStore;
  private readonly now: () => Date;
  private readonly usageByItem = new Map<string, number>();

  private judged = 0; private folded = 0; private dimmed = 0; private badged = 0;
  private kept = 0; private keptByRule = 0; private errors = 0; private cacheHits = 0;
  private arbitratedCount = 0; private inputTokens = 0;
  private readonly jevLatencies: number[] = [];
  private readonly sources: VerdictSource[] = [];

  constructor(opts: DuoAgentOptions) {
    this.llm = opts.llm;
    this._pack = opts.pack;
    this._settings = { strictness: DEFAULT_STRICTNESS, arbiter: true, ...opts.settings };
    this.exampleStore = opts.examples ?? new ExampleStore();
    this.now = opts.now ?? (() => new Date());
    const cache = opts.cache ?? new LruCache<Verdict>(CACHE_SIZE);
    this.evaluator = new Evaluator(tapUsage(opts.jev, this.usageByItem), { cache, strictness: () => this._settings.strictness });
    this.arbiter = opts.arbiter ?? new Arbiter(this.llm, { now: () => this.now().getTime() });
  }

  get pack(): QuestionPack | undefined { return this._pack; }
  setPack(pack: QuestionPack): void { this._pack = pack; }
  get settings(): DuoSettings { return this._settings; }
  updateSettings(p: Partial<DuoSettings>): void { this._settings = { ...this._settings, ...p }; }
  get examples(): ExampleStore { return this.exampleStore; }

  async compile(intent: string): Promise<QuestionPack> {
    const pack = await compilePack(intent, this.llm, { examples: this.exampleStore.list(), now: this.now });
    this._pack = pack;
    this.exampleStore.markRecompiled();
    return pack;
  }

  async recompile(): Promise<QuestionPack> {
    if (!this._pack) throw new ProviderError('no pack');
    return this.compile(this._pack.intent);
  }

  feedback(ex: Example): { shouldRecompile: boolean } {
    this.exampleStore.add(ex);
    return { shouldRecompile: this.exampleStore.shouldAutoRecompile() };
  }

  async judge(items: Item[], onVerdict?: VerdictListener): Promise<Verdict[]> {
    if (!this._pack) throw new ProviderError('no pack');
    const pack = this._pack;

    const verdicts = await this.evaluator.judge(pack, items, (v, item) => {
      // The Jev call (or cache hit) already happened at this point regardless of whether the
      // decision is still pending, so its cost/latency/cache-hit accounting happens unconditionally;
      // only the decision-kind counters wait for a non-pending (i.e. truly final) verdict.
      this.recordSource(v);
      if (v.decision.kind !== 'pending-arbiter') this.recordFinal(v);
      onVerdict?.(v, item);
    });

    for (let i = 0; i < verdicts.length; i++) {
      if (verdicts[i].decision.kind !== 'pending-arbiter') continue;
      const item = items[i];
      const final = await this.resolvePending(item, pack, verdicts[i]);
      verdicts[i] = final;
      this.recordFinal(final);
      onVerdict?.(final, item);
    }
    return verdicts;
  }

  stats(): DuoStats {
    return {
      judged: this.judged, folded: this.folded, dimmed: this.dimmed, badged: this.badged,
      kept: this.kept, keptByRule: this.keptByRule, errors: this.errors, cacheHits: this.cacheHits,
      arbitrated: this.arbitratedCount, p50LatencyMs: this.p50(),
      estimatedUsd: (this.inputTokens * JEV_INPUT_USD_PER_MTOK) / 1e6,
      inputTokens: this.inputTokens, lastSources: [...this.sources],
    };
  }

  private async resolvePending(item: Item, pack: QuestionPack, v: Verdict): Promise<Verdict> {
    if (!this._settings.arbiter) return { ...v, decision: { kind: 'keep' } };

    const result = await this.arbiter.arbitrate(item, pack, v);
    if (!result) return { ...v, decision: { kind: 'keep' } }; // no budget (or an invalid reply): fail open

    this.exampleStore.add(result.example);
    this.arbitratedCount += 1;
    return { ...v, decision: result.decision, source: 'arbiter' };
  }

  /** Cost/latency/cache-hit accounting for what happened at the Jev layer — called once per item,
   * even if its decision is still `pending-arbiter` and the item hasn't produced a final verdict yet. */
  private recordSource(v: Verdict): void {
    if (v.source === 'cache') this.cacheHits += 1;
    else if (v.source === 'error') this.errors += 1;
    else if (v.source === 'jev') {
      this.jevLatencies.push(v.latencyMs);
      if (this.jevLatencies.length > LAST_LATENCIES_MAX) this.jevLatencies.shift();
      const usage = this.usageByItem.get(v.itemId);
      this.usageByItem.delete(v.itemId);
      this.inputTokens += usage ?? 0;
    }
  }

  /** Decision-kind accounting — called exactly once per item, with its truly final verdict (after
   * arbitration, if any ran). */
  private recordFinal(v: Verdict): void {
    this.judged += 1;
    this.sources.push(v.source);
    if (this.sources.length > LAST_SOURCES_MAX) this.sources.shift();

    const d = v.decision;
    if (d.kind === 'fold') this.folded += 1;
    else if (d.kind === 'dim') this.dimmed += 1;
    else if (d.kind === 'badge') this.badged += 1;
    else if (d.kind === 'keep') {
      this.kept += 1;
      // reason is set either by a keep-rule match (its label) or by the arbiter ('arbiter'); only
      // the former is "kept by a rule" — a plain fail-open/default keep has no reason at all.
      if (d.reason !== undefined && d.reason !== 'arbiter') this.keptByRule += 1;
    }
  }

  private p50(): number {
    if (this.jevLatencies.length === 0) return 0;
    const sorted = [...this.jevLatencies].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length / 2) - 1];
  }
}
