import { MAX_TEXT_CHARS } from './constants';
import type { JevQuestion } from './providers/types';
import type { Item, QuestionPack } from './types';

const truncate = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** The JSON Jev sees for one item: platform/text plus the flags it is allowed to look at. `author` is omitted, not `null`, when the item has none. */
export function buildState(item: Item): Record<string, unknown> {
  return {
    platform: item.platform,
    ...(item.author !== undefined ? { author: item.author } : {}),
    text: truncate(item.text, MAX_TEXT_CHARS),
    hasLink: item.meta?.hasLink ?? false,
    hasMedia: item.meta?.hasMedia ?? false,
    isReply: item.meta?.isReply ?? false,
    isPromoted: item.meta?.isPromoted ?? false,
  };
}

/** Pack rules and keeps as Jev Noul questions: `r_<ruleId>` for hide rules (checked first), `k_<keepId>` for keeps. */
export function packQuestions(pack: QuestionPack): JevQuestion[] {
  return [
    ...pack.rules.map((r): JevQuestion => ({ id: `r_${r.id}`, type: 'noul', statement: r.question })),
    ...pack.keeps.map((k): JevQuestion => ({ id: `k_${k.id}`, type: 'noul', statement: k.question })),
  ];
}
