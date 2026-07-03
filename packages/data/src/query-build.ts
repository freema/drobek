/**
 * Query normalization for record_query / the REST list endpoint (U10, PHY-55)
 * — PURE, unit tested. This is the injection boundary: `where`/`sort` FIELDS
 * are whitelisted against the collection schema (+ a fixed set of metadata
 * columns) and never interpolated raw; VALUES are always parameterized by the
 * caller (records.server). Unknown fields are rejected, so a client can neither
 * probe arbitrary jsonb keys nor smuggle SQL.
 */
import { DataError } from './errors.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Row metadata columns a query may sort on (never `where`-filtered). */
export const META_SORT_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);

export type ScalarValue = string | number | boolean | null;

export interface WhereClause {
  field: string;
  value: ScalarValue;
}

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
  /** True when `field` is a metadata column, false when it is a doc property. */
  meta: boolean;
}

export interface CursorState {
  /** The ordering expression value of the last row, as text (or null). */
  v: string | null;
  /** The last row id (unique tiebreaker). */
  i: string;
}

function isScalar(v: unknown): v is ScalarValue {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * Validate a `where` filter (flat equality map) against the doc-property
 * whitelist. Only scalar values are allowed (no `{ $gt: … }`-style operators —
 * that surface does not exist in U10). Unknown field or non-scalar value →
 * invalid_request.
 */
export function normalizeWhere(
  where: unknown,
  docFields: Set<string>
): WhereClause[] {
  if (where === undefined || where === null) return [];
  if (typeof where !== 'object' || Array.isArray(where)) {
    throw new DataError('invalid_request', 'where must be an object');
  }
  const out: WhereClause[] = [];
  for (const [field, value] of Object.entries(where as Record<string, unknown>)) {
    if (!docFields.has(field)) {
      throw new DataError(
        'invalid_request',
        `where field "${field}" is not a property of this collection's schema`
      );
    }
    if (!isScalar(value)) {
      throw new DataError(
        'invalid_request',
        `where["${field}"] must be a string, number, boolean, or null`
      );
    }
    out.push({ field, value });
  }
  return out;
}

/**
 * Resolve the sort: default `createdAt desc` (newest first). A provided field
 * must be a metadata column OR a doc property; dir defaults to `asc`.
 */
export function normalizeSort(sort: unknown, docFields: Set<string>): SortSpec {
  if (sort === undefined || sort === null) {
    return { field: 'createdAt', dir: 'desc', meta: true };
  }
  if (typeof sort !== 'object' || Array.isArray(sort)) {
    throw new DataError('invalid_request', 'sort must be an object');
  }
  const s = sort as { field?: unknown; dir?: unknown };
  if (typeof s.field !== 'string') {
    throw new DataError('invalid_request', 'sort.field is required');
  }
  const meta = META_SORT_FIELDS.has(s.field);
  if (!meta && !docFields.has(s.field)) {
    throw new DataError(
      'invalid_request',
      `sort field "${s.field}" is not a property of this collection's schema`
    );
  }
  let dir: 'asc' | 'desc' = 'asc';
  if (s.dir !== undefined) {
    if (s.dir !== 'asc' && s.dir !== 'desc') {
      throw new DataError('invalid_request', 'sort.dir must be "asc" or "desc"');
    }
    dir = s.dir;
  }
  return { field: s.field, dir, meta };
}

export function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: unknown): CursorState | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string') {
    throw new DataError('invalid_request', 'cursor must be a string');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as CursorState;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.i !== 'string' ||
      !(parsed.v === null || typeof parsed.v === 'string')
    ) {
      throw new Error('shape');
    }
    return { v: parsed.v, i: parsed.i };
  } catch {
    throw new DataError('invalid_request', 'cursor is malformed');
  }
}
