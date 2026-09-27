/**
 * Name / slug search shared by the public gallery (SQL) and the dashboard
 * lists (in memory): case- and accent-insensitive, every other character
 * (including `%` and `_`) matches itself. Pure, so client bundles may import
 * it via `@drobek/apps/search`.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * NFD, combining accents stripped (the range the SQL side strips with
 * `regexp_replace(normalize(x, NFD), '[̀-ͯ]', '', 'g')`), lower case.
 */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Whether any of `fields` contains `query` after folding both; an empty query matches everything. */
export function matchesSearch(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const q = foldSearchText(query.trim());
  if (!q) return true;
  return fields.some((f) => typeof f === 'string' && foldSearchText(f).includes(q));
}

/**
 * The folded text as an ILIKE pattern `%<text>%` with the LIKE wildcards
 * `%`, `_` and the escape character `\` escaped, so every character matches
 * itself (used with `ESCAPE '\'` against the SQL-folded column).
 */
export function searchLikePattern(text: string): string {
  return `%${foldSearchText(text).replace(/[\\%_]/g, '\\$&')}%`;
}
