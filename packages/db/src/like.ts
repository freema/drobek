/** A LIKE / ILIKE pattern that matches `text` anywhere, with `%`, `_` and `\\` taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
