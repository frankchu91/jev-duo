/** Parses newline-delimited JSON. Blank lines are skipped silently; a line that fails to parse
 * calls `onBadLine(lineNo, err)` (1-indexed) and is skipped rather than aborting the whole batch —
 * shared by `compile`'s `--with-feedback` (`Example`s) and `judge`'s items (file or stdin). */
export function parseJsonl<T>(text: string, onBadLine: (lineNo: number, err: unknown) => void): T[] {
  const out: T[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      onBadLine(i + 1, err);
    }
  }
  return out;
}
