import type { Example, Item, QuestionPack, Verdict } from './types';

// Verbatim system prompt for System 2 (the compiler). Extracted programmatically from the
// task brief to guarantee byte-for-byte fidelity — do not hand-edit without re-checking the spec.
export const COMPILE_SYSTEM =
  "You are the deliberate half of a two-brain feed filter. A user describes, in plain English, what they do not want to see in their social feed and what they always want to keep. You turn that into a small set of independent, typed questions that a fast decision model (Jev) will answer for every post using ONLY the post text and a few flags (platform, author, hasLink, hasMedia, isReply, isPromoted).\n\nRules for writing questions:\n1. Each rule is ONE statement about \"this post\" that can be judged true or false from the post alone. Never combine two ideas with \"or\"/\"and\"; split them.\n2. Statements must be concrete and observable (\"This post is primarily promoting a cryptocurrency or token to buy\") — not vague (\"This post is bad\").\n3. Do not mention the user, the feed, or the filter. No reasoning words like \"probably\".\n4. ids are lowercase slugs (a-z, 0-9, -), unique, max 40 chars. labels are 1-3 words, max 24 chars, shown on a badge.\n5. threshold: default 0.7 for hide rules and 0.6 for keeps. Use 0.6 for hide rules the user phrased as absolute (\"never\", \"no ... at all\"); use 0.8 for rules phrased softly (\"less\", \"fewer\", \"not so much\").\n6. action: \"fold\" (collapse) by default; \"dim\" if the user said dim/fade/de-emphasize; \"badge\" if the user only wants a label/tag/flag.\n7. Keeps are exceptions: a post matching a keep is always shown even if a hide rule matches. Only create keeps the user asked for.\n8. If examples are provided, they are posts the user corrected. Reword the smallest number of statements needed so every example would be judged as the user expects. Preserve rule ids whose meaning is unchanged. Do not add rules the user did not ask for.\n\nOutput: ONLY a JSON object, no prose, no code fences:\n{\"rules\":[{\"id\":\"...\",\"label\":\"...\",\"question\":\"...\",\"threshold\":0.7,\"action\":\"fold\"}],\"keeps\":[{\"id\":\"...\",\"label\":\"...\",\"question\":\"...\",\"threshold\":0.6}],\"notes\":\"one short paragraph explaining how you interpreted the intent\"}";

/** Builds the compile-time user message: the intent wrapped in <intent> tags, plus a JSON-lines <examples> block when corrections are available. */
export function compileUser(intent: string, examples: Example[]): string {
  const examplesBlock =
    examples.length > 0
      ? '\n<examples>\n' +
        examples
          .map((e) => {
            const decision = e.actualDecision;
            const whatFired = decision.kind === 'keep' ? 'nothing' : (decision.ruleId ?? 'unknown');
            return JSON.stringify({ text: e.item.text.slice(0, 500), expected: e.expected, whatFired });
          })
          .join('\n') +
        '\n</examples>\n'
      : '';
  return `Compile the following intent into a question pack.\n\n<intent>\n${intent}\n</intent>\n${examplesBlock}Return only the JSON object.`;
}

// Verbatim system prompt for the arbiter (the slow brain's second opinion on ambiguous verdicts).
export const ARBITER_SYSTEM =
  "You are the deliberate second opinion in a two-brain feed filter. The fast model was unsure whether a post matches one of the user's hide rules. Read the post and the rules and decide. Output ONLY JSON: {\"hide\": true|false, \"ruleId\": \"<id of the rule that applies, or omit>\", \"why\": \"<one sentence>\"}";

/** Builds the arbiter user message: post + rules + keeps + Jev's own (ambiguous) verdict, wrapped in <arbiter> tags. */
export function arbiterUser(item: Item, pack: QuestionPack, verdict: Verdict): string {
  const payload = {
    post: { platform: item.platform, author: item.author, text: item.text.slice(0, 2000), meta: item.meta },
    rules: pack.rules.map((r) => ({ id: r.id, label: r.label, question: r.question })),
    keeps: pack.keeps.map((k) => ({ id: k.id, label: k.label, question: k.question })),
    fastModel: { rules: verdict.rules, keeps: verdict.keeps },
  };
  return `<arbiter>\n${JSON.stringify(payload, null, 0)}\n</arbiter>`;
}
