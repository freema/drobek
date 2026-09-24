/**
 * Pure helpers for the dashboard Data tab: a record → the table's cells (+
 * the fields that are not columns), a short schema summary, and the table's
 * filter/sort query params → the records query. Unit tested; imported only by
 * the server halves of the Data routes (loaders pre-shape every row).
 */

export interface Column {
  key: string;
  required: boolean;
}

/** The server's record fields (the table shows them separately). */
const SYSTEM_FIELDS = new Set(['_id', '_owner', '_created_at', '_updated_at']);

/** The server's fields a query may sort on. */
const META_SORT_FIELDS = new Set(['_id', '_created_at', '_updated_at']);

/** A short one-line summary of the columns (required keys marked `*`). */
export function schemaSummary(columns: Column[], max = 6): string {
  if (columns.length === 0) return '(no schema)';
  const shown = columns.slice(0, max).map((c) => (c.required ? `${c.key}*` : c.key));
  const extra = columns.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
}

/** A value as one display string: scalars as text, objects/arrays as JSON, missing/null empty. */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface FlatRow {
  /** One display string per column, in column order. */
  cells: string[];
  /** The record's own fields that are NOT columns (per-row expander). */
  extra: Record<string, unknown>;
  hasExtra: boolean;
}

/** A record → the column cells + its other own fields (the `_…` fields are never "extra"). */
export function flattenRecord(record: unknown, columns: Column[]): FlatRow {
  const obj = typeof record === 'object' && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>) : {};
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);
  const known = new Set(columns.map((c) => c.key));
  const cells = columns.map((c) => cellText(own(c.key)));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k) && !SYSTEM_FIELDS.has(k)) extra[k] = v;
  }
  return { cells, extra, hasExtra: Object.keys(extra).length > 0 };
}

export interface FilterSort {
  filter?: Record<string, string>;
  sort?: string;
  dir?: 'asc' | 'desc';
}

/**
 * The table's params → the records query. A filter field must be a column
 * (else dropped), a sort field a column or `_id` / `_created_at` /
 * `_updated_at` (else the default, newest first). A hand-crafted param is
 * ignored rather than failing the page. The value stays a string: the data
 * module matches it against the field's text (`true` matches true).
 */
export function mapFilterSort(input: {
  filterField?: string | null;
  filterValue?: string | null;
  sortField?: string | null;
  dir?: string | null;
  columns: Column[];
}): FilterSort {
  const known = new Set(input.columns.map((c) => c.key));
  const out: FilterSort = {};
  const ff = (input.filterField ?? '').trim();
  if (ff && known.has(ff)) out.filter = { [ff]: input.filterValue ?? '' };
  const sf = (input.sortField ?? '').trim();
  if (sf && (known.has(sf) || META_SORT_FIELDS.has(sf))) {
    out.sort = sf;
    out.dir = input.dir === 'asc' ? 'asc' : 'desc';
  }
  return out;
}

/** `rules` → one line, e.g. `read public · create admin · …`. */
export function rulesText(rules: Record<string, string>): string {
  return ['read', 'create', 'update', 'delete']
    .filter((op) => typeof rules[op] === 'string')
    .map((op) => `${op} ${rules[op]}`)
    .join(' · ');
}
