/**
 * Display columns and CSV rows of a collection — PURE, unit tested. Every
 * exported cell goes through `csvLine` of @drobek/core, which neutralizes
 * spreadsheet formulas (`=1+1` → `'=1+1`): record values of a `create: public`
 * collection are attacker-controlled.
 */
import { csvLine } from '@drobek/core';

export interface SchemaColumn {
  key: string;
  required: boolean;
}

/** The server's fields, first in every export. */
export const SYSTEM_COLUMNS = ['_id', '_owner', '_created_at', '_updated_at'] as const;

function propsOf(jsonSchema: unknown): Record<string, unknown> {
  if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) return {};
  const props = (jsonSchema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return {};
  return props as Record<string, unknown>;
}

function requiredOf(jsonSchema: unknown): string[] {
  if (typeof jsonSchema !== 'object' || jsonSchema === null) return [];
  const req = (jsonSchema as { required?: unknown }).required;
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * Ordered columns of a collection schema: the `required` properties first (in
 * the `required` array's order — arrays survive jsonb), then the other
 * top-level properties. `_…` properties are the server's and never columns.
 */
export function schemaColumns(jsonSchema: unknown): SchemaColumn[] {
  const props = propsOf(jsonSchema);
  const cols: SchemaColumn[] = [];
  const seen = new Set<string>();
  for (const key of requiredOf(jsonSchema)) {
    if (Object.prototype.hasOwnProperty.call(props, key) && !seen.has(key) && !key.startsWith('_')) {
      cols.push({ key, required: true });
      seen.add(key);
    }
  }
  for (const key of Object.keys(props)) {
    if (!seen.has(key) && !key.startsWith('_')) {
      cols.push({ key, required: false });
      seen.add(key);
    }
  }
  return cols;
}

/** A value as one display/CSV string: scalars as text, objects/arrays as JSON, missing/null empty. */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The CSV header: the server's fields, then `keys`. */
export function csvHeader(keys: string[]): string {
  return csvLine([...SYSTEM_COLUMNS, ...keys]);
}

/** One CSV line of a record (`{ _id, _owner, …fields }`) for `keys`. */
export function csvRecordLine(record: Record<string, unknown>, keys: string[]): string {
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(record, k) ? record[k] : undefined);
  return csvLine([...SYSTEM_COLUMNS.map((k) => cellText(own(k))), ...keys.map((k) => cellText(own(k)))]);
}
