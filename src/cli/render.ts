import type { DuoStats, Item, Verdict } from '../core/index.js';

const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[0m';
const TITLE_MAX_CHARS = 80;
const LABEL_WIDTH = 14;
const RANK_WIDTH = 2;
const SEP = ' · '; // " · "

/** Whether a `keep` counts as "by rule": `reason` is set by a matched keep-rule (its label) or by
 * the arbiter ('arbiter'); only the former is "by rule" — mirrors DuoAgent's own `keptByRule` stat. */
function isKeepByRule(decision: Verdict['decision']): boolean {
  return decision.kind === 'keep' && decision.reason !== undefined && decision.reason !== 'arbiter';
}

function glyphFor(v: Verdict): string {
  if (v.source === 'error') return '!';
  const d = v.decision;
  if (d.kind === 'fold') return '⚡'; // ⚡
  if (d.kind === 'dim') return '◐'; // ◐
  if (d.kind === 'badge') return '◦'; // ◦
  if (isKeepByRule(d)) return '★'; // ★
  return '✓'; // ✓ (plain keep, or an arbiter-resolved keep)
}

function labelFor(v: Verdict): string {
  const d = v.decision;
  if (d.kind === 'fold' || d.kind === 'dim' || d.kind === 'badge') return `${d.label} ${Math.round(d.p * 100)}%`;
  return '';
}

function medianLatency(verdicts: Verdict[]): number {
  if (verdicts.length === 0) return 0;
  const sorted = verdicts.map((v) => v.latencyMs).sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

/** Falls back to counting straight off `verdicts` when the caller has no `DuoStats` handy (e.g. a
 * standalone unit test); real commands always pass `agent.stats()` for the authoritative numbers. */
function statsFromVerdicts(verdicts: Verdict[]): DuoStats {
  const judged = verdicts.length;
  const folded = verdicts.filter((v) => v.decision.kind === 'fold').length;
  const dimmed = verdicts.filter((v) => v.decision.kind === 'dim').length;
  const badged = verdicts.filter((v) => v.decision.kind === 'badge').length;
  const kept = verdicts.filter((v) => v.decision.kind === 'keep').length;
  const keptByRule = verdicts.filter((v) => isKeepByRule(v.decision)).length;
  const errors = verdicts.filter((v) => v.source === 'error').length;
  const cacheHits = verdicts.filter((v) => v.source === 'cache').length;
  const arbitrated = verdicts.filter((v) => v.source === 'arbiter').length;
  return {
    judged, folded, dimmed, badged, kept, keptByRule, errors, cacheHits, arbitrated,
    p50LatencyMs: medianLatency(verdicts), estimatedUsd: 0, inputTokens: 0,
    lastSources: verdicts.map((v) => v.source),
  };
}

function footerLine(stats: DuoStats): string {
  const parts = [
    `judged ${stats.judged}`, `folded ${stats.folded}`, `dimmed ${stats.dimmed}`,
    `kept ${stats.kept}`, `errors ${stats.errors}`, `p50 ${stats.p50LatencyMs}ms`,
    `~$${stats.estimatedUsd.toFixed(4)}`,
  ];
  return parts.join(SEP);
}

/** One line per item (`rank glyph label title`) plus a trailing stats footer. Pure formatting, no I/O. */
export function renderTable(items: Item[], verdicts: Verdict[], opts: { color?: boolean; stats?: DuoStats } = {}): string {
  const lines = items.map((item, i) => {
    const v = verdicts[i];
    const rank = String(i + 1).padStart(RANK_WIDTH, ' ');
    const glyph = glyphFor(v);
    const label = labelFor(v).padEnd(LABEL_WIDTH, ' ');
    const title = item.text.slice(0, TITLE_MAX_CHARS);
    const line = `${rank} ${glyph} ${label} ${title}`;
    return opts.color && v.decision.kind === 'fold' ? `${DIM_ON}${line}${DIM_OFF}` : line;
  });
  lines.push(footerLine(opts.stats ?? statsFromVerdicts(verdicts)));
  return lines.join('\n');
}

/** One JSON-serialised verdict per line, in input order. Pure formatting, no I/O. */
export function renderJsonl(verdicts: Verdict[]): string {
  return verdicts.map((v) => JSON.stringify(v)).join('\n');
}
