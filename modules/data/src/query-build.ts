/**
 * Query normalization for the list endpoint, query_data and the dashboard —
 * PURE, unit tested. This is the injection boundary: a filter is a small JSON
 * object of whitelisted fields × whitelisted operators with scalar values;
 * nothing a client sends is ever interpolated into SQL (store.ts binds every
 * field name and value as a parameter). With a schema, only its declared
 * properties may be filtered or sorted on; without one, a field must look like
 * an identifier. Keys starting with `_` belong to the server.
 */
import { DataError } from './errors.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** At most this many conditions (field × operator) in one filter. */
export const MAX_CONDITIONS = 8;
/** At most this many values in one `in` list. */
export const MAX_IN_VALUES = 50;
/** A scalar filter value (strings) is capped at this many characters. */
export const MAX_VALUE_CHARS = 500;

/** The server's record fields a query may sort on. */
export const META_SORT_FIELDS = new Set(['_id', '_created_at', '_updated_at']);

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
const OP_SET = new Set<string>(FILTER_OPS);

/** A field name a schemaless collection may be queried on. */
export const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type ScalarValue = string | number | boolean | null;

export interface Condition {
  field: string;
  op: FilterOp;
  /** A scalar, or a list of scalars for `in`. */
  value: ScalarValue | ScalarValue[];
}

export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
  /** True when `field` is a server field (`_id`, `_created_at`, `_updated_at`). */
  meta: boolean;
}

export interface CursorState {
  /** The ordering value of the last row, as the text of its JSON (or null). */
  v: string | null;
  /** The last row id (unique tiebreaker). */
  i: string;
}

function isScalar(v: unknown): v is ScalarValue {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
}

function checkScalar(field: string, op: string, v: unknown): ScalarValue {
  if (!isScalar(v)) {
    throw new DataError('invalid_request', `filter ${field}.${op} must be a string, a finite number, true/false or null`);
  }
  if (typeof v === 'string' && v.length > MAX_VALUE_CHARS) {
    throw new DataError('invalid_request', `filter ${field}.${op}: values are at most ${MAX_VALUE_CHARS} characters`);
  }
  return v;
}

/**
 * May `field` be filtered/sorted on? With a schema (`docFields` non-null) it
 * must be a declared property; without one, identifier-shaped. Never a
 * server (`_…`) field.
 */
export function fieldAllowed(field: string, docFields: Set<string> | null): boolean {
  if (typeof field !== 'string' || field.startsWith('_')) return false;
  return docFields ? docFields.has(field) : FIELD_RE.test(field);
}

function assertField(field: string, docFields: Set<string> | null, what: 'filter' | 'sort'): void {
  if (!fieldAllowed(field, docFields)) {
    throw new DataError(
      'invalid_request',
      docFields
        ? `${what} field "${field}" is not a property of this collection's schema`
        : `${what} field "${field}" is not a valid field name (letters, digits, - and _; not starting with _)`
    );
  }
}

/**
 * Validate a filter: `{ field: value }` (equality) or
 * `{ field: { eq|ne|gt|gte|lt|lte|contains: value, in: [values] } }`.
 * Unknown field / operator, a non-scalar value or more than MAX_CONDITIONS
 * conditions → invalid_request.
 */
export function normalizeFilter(filter: unknown, docFields: Set<string> | null): Condition[] {
  if (filter === undefined || filter === null) return [];
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new DataError('invalid_request', 'filter must be an object: { field: value } or { field: { op: value } }');
  }
  const out: Condition[] = [];
  for (const [field, spec] of Object.entries(filter as Record<string, unknown>)) {
    assertField(field, docFields, 'filter');
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      const ops = Object.entries(spec as Record<string, unknown>);
      if (ops.length === 0) throw new DataError('invalid_request', `filter ${field} has no operator`);
      for (const [op, v] of ops) {
        if (!OP_SET.has(op)) {
          throw new DataError('invalid_request', `filter ${field}: unknown operator "${op}" (use ${FILTER_OPS.join(', ')})`);
        }
        if (op === 'in') {
          if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IN_VALUES) {
            throw new DataError('invalid_request', `filter ${field}.in must be a list of 1–${MAX_IN_VALUES} values`);
          }
          out.push({ field, op: 'in', value: v.map((x) => checkScalar(field, op, x)) });
          continue;
        }
        const value = checkScalar(field, op, v);
        if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && typeof value !== 'number' && typeof value !== 'string') {
          throw new DataError('invalid_request', `filter ${field}.${op} compares numbers or strings`);
        }
        if (op === 'contains' && value === null) {
          throw new DataError('invalid_request', `filter ${field}.contains needs a value`);
        }
        out.push({ field, op: op as FilterOp, value });
      }
    } else {
      out.push({ field, op: 'eq', value: checkScalar(field, 'eq', spec) });
    }
  }
  if (out.length > MAX_CONDITIONS) {
    throw new DataError('invalid_request', `a filter has at most ${MAX_CONDITIONS} conditions`);
  }
  return out;
}

/** Parse the `filter` query parameter (JSON text). */
export function parseFilterParam(raw: string | undefined | null): unknown {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new DataError('invalid_request', 'filter must be JSON, e.g. {"done":false}');
  }
}

/**
 * Resolve the sort: default `_created_at desc` (newest first). A provided
 * field must be a server field or an allowed record field; dir defaults to
 * `asc`.
 */
export function normalizeSort(sort: unknown, docFields: Set<string> | null): SortSpec {
  if (sort === undefined || sort === null) {
    return { field: '_created_at', dir: 'desc', meta: true };
  }
  if (typeof sort !== 'object' || Array.isArray(sort)) {
    throw new DataError('invalid_request', 'sort must be an object');
  }
  const s = sort as { field?: unknown; dir?: unknown };
  if (typeof s.field !== 'string') {
    throw new DataError('invalid_request', 'sort.field is required');
  }
  const meta = META_SORT_FIELDS.has(s.field);
  if (!meta) assertField(s.field, docFields, 'sort');
  let dir: 'asc' | 'desc' = 'asc';
  if (s.dir !== undefined && s.dir !== null) {
    if (s.dir !== 'asc' && s.dir !== 'desc') {
      throw new DataError('invalid_request', 'dir must be "asc" or "desc"');
    }
    dir = s.dir;
  }
  return { field: s.field, dir, meta };
}

export function clampLimit(limit: unknown, max = MAX_LIMIT): number {
  if (limit === undefined || limit === null || limit === '') return Math.min(DEFAULT_LIMIT, max);
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) return Math.min(DEFAULT_LIMIT, max);
  return Math.min(n, max);
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: unknown): CursorState | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 2048) {
    throw new DataError('invalid_request', 'cursor is malformed');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.i !== 'string' ||
      !(parsed.v === null || typeof parsed.v === 'string')
    ) {
      throw new Error('shape');
    }
    if (parsed.v !== null) JSON.parse(parsed.v); // the text of a JSON value
    return { v: parsed.v, i: parsed.i };
  } catch {
    throw new DataError('invalid_request', 'cursor is malformed');
  }
}
