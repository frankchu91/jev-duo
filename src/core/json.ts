/** Extracts a JSON object from LLM output: strips ``` fences, takes the first '{'..last '}', and parses it. */
export function extractJson(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new SyntaxError('no JSON object found');
  return JSON.parse(unfenced.slice(start, end + 1));
}
