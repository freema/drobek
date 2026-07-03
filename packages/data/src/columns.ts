/**
 * Pure, react/db-free helpers for the dashboard Data tab (M1b, PHY-121): flatten
 * a collection's JSON Schema to ordered display COLUMNS, summarize it, flatten a
 * document to those columns (+ the leftover non-schema keys), map the dashboard's
 * filter/sort query params onto the U10 query API, and serialize records to CSV
 * (RFC-4180 escaping). Unit-tested in isolation; imported only server-side (the
 * dashboard loaders pre-shape rows so the client bundle never pulls this in).
 */

import { META_SORT_FIELDS } from './query-build.js';

export interface SchemaColumn {
  key: string;
  required: boolean;
}

function propsOf(jsonSchema: unknown): Record<string, unknown> {
  if (
    typeof jsonSchema !== 'object' ||
    jsonSchema === null ||
    Array.isArray(jsonSchema)
  ) {
    return {};
  }
  const props = (jsonSchema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return {};
  }
  return props as Record<string, unknown>;
}

function requiredOf(jsonSchema: unknown): string[] {
  if (typeof jsonSchema !== 'object' || jsonSchema === null) return [];
  const req = (jsonSchema as { required?: unknown }).required;
  if (!Array.isArray(req)) return [];
  return req.filter((r): r is string => typeof r === 'string');
}

/**
 * Ordered display columns for a collection schema: the `required` properties
 * first (in the schema's `required` array order — arrays survive the jsonb
 * round-trip), then the remaining top-level properties. Deterministic and does
 * NOT rely on object-key insertion order, which Postgres jsonb does not preserve.
 */
export function schemaColumns(jsonSchema: unknown): SchemaColumn[] {
  const props = propsOf(jsonSchema);
  const cols: SchemaColumn[] = [];
  const seen = new Set<string>();
  for (const key of requiredOf(jsonSchema)) {
    if (key in props && !seen.has(key)) {
      cols.push({ key, required: true });
      seen.add(key);
    }
  }
  for (const key of Object.keys(props)) {
    if (!seen.has(key)) {
      cols.push({ key, required: false });
      seen.add(key);
    }
  }
  return cols;
}

/** A short one-line schema summary for the collections list (required keys `*`). */
export function schemaSummary(jsonSchema: unknown, max = 6): string {
  const cols = schemaColumns(jsonSchema);
  if (cols.length === 0) return '(no fields)';
  const shown = cols
    .slice(0, max)
    .map((c) => (c.required ? `${c.key}*` : c.key));
  const extra = cols.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
}

/** Render a scalar jsonb value to a display/CSV string; objects/arrays → JSON. */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export interface FlatRow {
  /** One display string per column, in column order. */
  cells: string[];
  /** Doc keys that are NOT schema columns → shown under a per-row expander. */
  extra: Record<string, unknown>;
  hasExtra: boolean;
}

/** Flatten a doc to the ordered column cells + the leftover (non-schema) keys. */
export function flattenDoc(doc: unknown, columns: SchemaColumn[]): FlatRow {
  const obj =
    typeof doc === 'object' && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  const known = new Set(columns.map((c) => c.key));
  const cells = columns.map((c) => cellText(obj[c.key]));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extra[k] = v;
  }
  return { cells, extra, hasExtra: Object.keys(extra).length > 0 };
}

// ── filter / sort param mapping ──────────────────────────────────────────────

export interface FilterSort {
  where?: Record<string, string>;
  sort?: { field: string; dir: 'asc' | 'desc' };
}

/**
 * Map the dashboard's raw query params to the @drobek/data query shape. An
 * unknown/blank filter field is DROPPED and an unknown sort field falls back to
 * the default (createdAt desc) — the table UI only offers schema fields (+ the
 * createdAt/updatedAt/id metadata columns for sort), so a hand-crafted unknown
 * param is silently ignored rather than 500-ing the page. The value passes
 * through as a string; U10 compares `doc ->> field = <value>` as text.
 */
export function mapFilterSort(input: {
  filterField?: string | null;
  filterValue?: string | null;
  sortField?: string | null;
  dir?: string | null;
  columns: SchemaColumn[];
}): FilterSort {
  const known = new Set(input.columns.map((c) => c.key));
  const out: FilterSort = {};

  const ff = (input.filterField ?? '').trim();
  if (ff && known.has(ff)) {
    out.where = { [ff]: input.filterValue ?? '' };
  }

  const sf = (input.sortField ?? '').trim();
  if (sf && (known.has(sf) || META_SORT_FIELDS.has(sf))) {
    out.sort = { field: sf, dir: input.dir === 'asc' ? 'asc' : 'desc' };
  }
  return out;
}

// ── CSV (RFC-4180) ───────────────────────────────────────────────────────────

/** Escape one CSV field: wrap in quotes + double internal quotes when needed. */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A single CSV line (no trailing newline) from raw cell strings. */
export function csvLine(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/** The CSV header row — the schema field names, in column order. */
export function csvHeader(columns: SchemaColumn[]): string {
  return csvLine(columns.map((c) => c.key));
}

/** The CSV data row for a doc, honoring column order + escaping. */
export function csvRow(doc: unknown, columns: SchemaColumn[]): string {
  return csvLine(flattenDoc(doc, columns).cells);
}
