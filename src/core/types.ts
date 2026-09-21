export type Platform = 'x' | 'reddit' | 'hn' | 'generic';

export interface ItemMeta {
  hasLink?: boolean; hasMedia?: boolean; isReply?: boolean;
  isPromoted?: boolean; score?: number; comments?: number;
}

export interface Item {
  id: string;
  platform: Platform;
  author?: string;
  text: string;
  url?: string;
  meta?: ItemMeta;
}

export type Action = 'fold' | 'dim' | 'badge';

export interface Rule {
  id: string;
  label: string;
  question: string;
  threshold: number;
  action: Action;
  ambiguous: [number, number];
}

export interface KeepRule {
  id: string;
  label: string;
  question: string;
  threshold: number;
}

export interface QuestionPack {
  version: 1;
  intent: string;
  compiledAt: string;
  compiledBy: string;
  rules: Rule[];
  keeps: KeepRule[];
  notes?: string;
}

export interface RuleVerdict { ruleId: string; p: number; }

export type Decision =
  | { kind: 'keep'; reason?: string }
  | { kind: 'fold' | 'dim' | 'badge'; ruleId: string; label: string; p: number }
  | { kind: 'pending-arbiter'; ruleId: string; p: number };

export type VerdictSource = 'jev' | 'cache' | 'arbiter' | 'error';

export interface Verdict {
  itemId: string;
  rules: RuleVerdict[];
  keeps: RuleVerdict[];
  decision: Decision;
  latencyMs: number;
  source: VerdictSource;
  error?: string;
}

export interface Example {
  item: Item;
  expected: 'show' | 'hide';
  actualDecision: Decision;
  source: 'user' | 'arbiter';
  at: string;
}
