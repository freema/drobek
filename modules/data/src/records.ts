/**
 * The query layer shared by the REST routes and the owner's view (the
 * `records` authority behind MCP `query_data` and the dashboard Data tab).
 *
 * The authority answers the app OWNER — core calls it only after it
 * authorized a drobek account for the app — so it bypasses the end-user rules;
 * it is still scoped to the ONE app of its view, and only to collections the
 * app's config declares (anything else → not_found).
 */
import { CsvParseError, csvUnguard, parseCsv } from '@drobek/core';
import type { DB } from '@drobek/db';
import { RECORDS_IMPORT_MAX_ROWS, isModuleError, type RecordsAuthority, type RecordsCollection, type RecordsQuery, type RecordsView } from '@drobek/modules';
import { schemaColumns, csvHeader, csvRecordLine } from './columns.js';
import { collectionConfig, rulesOf, type CollectionConfig, type DataConfig } from './config.js';
import { DataError } from './errors.js';
import { clampLimit, decodeCursor, normalizeFilter, normalizeSort, type Condition, type SortSpec } from './query-build.js';
import { dataQuotaFromLimits, docByteSize } from './quota.js';
import { schemaPropertyNames, validateDocument } from './schema-validate.js';
import {
  countMatching,
  countsByCollection,
  deleteCollectionRecords,
  deleteRecord,
  insertRecords,
  loadRecord,
  patchRecord,
  queryRecords,
  toRecord,
  type DataRecord,
} from './store.js';

/** The declared collection `name`, or not_found. */
export function requireCollection(config: DataConfig, name: string): CollectionConfig {
  const c = collectionConfig(config, name);
  if (!c) {
    throw new DataError(
      'not_found',
      `This app has no collection "${name}". Declare it first: configure_module('data', { collections: { "${name}": { rules: { … } } } }).`
    );
  }
  return c;
}

/** With a schema, the only fields a query may use; null (any identifier) without one. */
function docFieldsOf(c: CollectionConfig): Set<string> | null {
  return c.schema ? schemaPropertyNames(c.schema) : null;
}

export interface PageQuery {
  filter?: unknown;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: unknown;
  cursor?: unknown;
}

/** The sort of a query: `sort` (+ `dir`, default asc), or `_created_at` in `dir` (default newest first). */
function sortOf(q: { sort?: string; dir?: 'asc' | 'desc' }, docFields: Set<string> | null): SortSpec {
  if (q.sort) return normalizeSort({ field: q.sort, dir: q.dir }, docFields);
  return normalizeSort(q.dir ? { field: '_created_at', dir: q.dir } : undefined, docFields);
}

interface Normalized {
  conditions: Condition[];
  sort: SortSpec;
}

function normalizeQuery(c: CollectionConfig, q: PageQuery): Normalized {
  const docFields = docFieldsOf(c);
  return { conditions: normalizeFilter(q.filter, docFields), sort: sortOf(q, docFields) };
}

/** One page of a declared collection (`ownerId` narrows it to one owner's records). */
export async function pageOf(
  db: DB,
  appId: string,
  name: string,
  c: CollectionConfig,
  q: PageQuery,
  opts: { ownerId: string | null; maxLimit: number; withTotal?: boolean }
): Promise<{ records: DataRecord[]; next_cursor: string | null; total?: number }> {
  const { conditions, sort } = normalizeQuery(c, q);
  const base = { appId, collection: name, ownerId: opts.ownerId, conditions };
  const { rows, nextCursor } = await queryRecords(db, {
    ...base,
    sort,
    limit: clampLimit(q.limit, opts.maxLimit),
    cursor: decodeCursor(q.cursor),
  });
  const out: { records: DataRecord[]; next_cursor: string | null; total?: number } = { records: rows.map(toRecord), next_cursor: nextCursor };
  if (opts.withTotal) out.total = await countMatching(db, base);
  return out;
}

const CSV_PAGE = 500;

/**
 * The CSV lines of a collection (header first; filter + sort applied). A
 * schema gives the columns; without one, every key any matching record has
 * (sorted — a first pass collects them).
 */
export async function* csvLines(
  db: DB,
  appId: string,
  name: string,
  c: CollectionConfig,
  q: Omit<PageQuery, 'limit' | 'cursor'>,
  ownerId: string | null = null
): AsyncGenerator<string> {
  const { conditions, sort } = normalizeQuery(c, q);
  const pages = async function* () {
    let cursor = null;
    do {
      const page = await queryRecords(db, { appId, collection: name, ownerId, conditions, sort, limit: CSV_PAGE, cursor });
      yield page.rows.map(toRecord);
      cursor = page.nextCursor ? decodeCursor(page.nextCursor) : null;
    } while (cursor);
  };
  let keys: string[];
  if (c.schema) {
    keys = schemaColumns(c.schema).map((col) => col.key);
  } else {
    const seen = new Set<string>();
    for await (const records of pages()) for (const r of records) for (const k of Object.keys(r)) if (!k.startsWith('_')) seen.add(k);
    keys = [...seen].sort();
  }
  yield csvHeader(keys);
  for await (const records of pages()) for (const r of records) yield csvRecordLine(r, keys);
}

function describe(name: string, c: CollectionConfig, records: number): RecordsCollection {
  return { name, rules: { ...rulesOf(c) }, schema: c.schema ?? null, columns: schemaColumns(c.schema), records };
}

/** A record's own fields: every key but the server's `_…` ones. */
function ownFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (!k.startsWith('_') && v !== undefined) out[k] = v;
  return out;
}

/** The JSON Schema `type`s a property declares ([] when none). */
function propertyTypes(schema: unknown, key: string): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const prop = props && typeof props === 'object' ? (props as Record<string, unknown>)[key] : undefined;
  const t = prop && typeof prop === 'object' ? (prop as { type?: unknown }).type : undefined;
  if (typeof t === 'string') return [t];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * One CSV cell as the value the schema asks for: `number` / `integer` from a
 * numeric cell, `boolean` from true/false, `null` from "null", `object` /
 * `array` from JSON; anything else stays text (the schema then refuses it
 * with a clear field error). Without a declared type a cell stays text.
 */
function cellValue(raw: string, types: string[]): unknown {
  const nonText = types.filter((t) => t !== 'string');
  for (const t of nonText) {
    if ((t === 'number' || t === 'integer') && NUMBER_RE.test(raw.trim())) return Number(raw.trim());
    if (t === 'boolean' && /^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === 'true';
    if (t === 'null' && raw.trim() === 'null') return null;
    if (t === 'object' || t === 'array') {
      try {
        const v = JSON.parse(raw) as unknown;
        if (t === 'array' ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {
        /* stays text */
      }
    }
  }
  return raw;
}

/** An import row that does not fit: `validation_failed` naming the CSV line, nothing stored. */
function rowError(line: number, message: string, errors?: unknown): DataError {
  return new DataError('validation_failed', `Line ${line}: ${message}. Nothing was imported.`, { details: { line, errors: errors ?? [] } });
}

/** Parse + validate an import (everything before a write): the records with the CSV line each starts on. */
function importDocs(c: CollectionConfig, text: string): { line: number; doc: Record<string, unknown> }[] {
  let rows;
  try {
    rows = parseCsv(text, { maxRows: RECORDS_IMPORT_MAX_ROWS + 1 });
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new DataError('invalid_request', `The file is not valid CSV — ${err.message}. Nothing was imported.`, { details: { line: err.line } });
    }
    throw err;
  }
  if (rows.length > RECORDS_IMPORT_MAX_ROWS + 1) {
    throw new DataError('payload_too_large', `The file has more than ${RECORDS_IMPORT_MAX_ROWS} rows; import at most ${RECORDS_IMPORT_MAX_ROWS} at a time. Nothing was imported.`, {
      details: { limit: 'RECORDS_IMPORT_MAX_ROWS', value: RECORDS_IMPORT_MAX_ROWS },
    });
  }
  const [header, ...data] = rows;
  if (!header || data.length === 0) {
    throw new DataError('invalid_request', 'The file has no records: the first line names the fields, every following line is one record.');
  }
  const names = header.cells.map((n) => n.trim());
  const seen = new Set<string>();
  names.forEach((n, i) => {
    if (!n) throw rowError(header.line, `column ${i + 1} has no name in the header`);
    if (n.length > 64) throw rowError(header.line, `the column name "${n.slice(0, 64)}…" is longer than 64 characters`);
    if (seen.has(n)) throw rowError(header.line, `the column "${n}" appears twice in the header`);
    seen.add(n);
  });
  const types = names.map((n) => (c.schema ? propertyTypes(c.schema, n) : []));
  return data.map((row) => {
    if (row.cells.length !== names.length) {
      throw rowError(row.line, `${row.cells.length} cells, but the header names ${names.length} columns`);
    }
    const doc: Record<string, unknown> = {};
    names.forEach((n, i) => {
      if (n.startsWith('_')) return; // the server's fields of an export: never imported
      const raw = csvUnguard(row.cells[i]);
      if (raw !== '') doc[n] = cellValue(raw, types[i]);
    });
    if (c.schema) {
      try {
        validateDocument(c.schema, doc);
      } catch (err) {
        if (isModuleError(err) && err.code === 'validation_failed') {
          const errors = err.details as { path: string; message: string }[] | undefined;
          const first = errors?.[0];
          throw rowError(row.line, first ? `${first.path || 'the record'} ${first.message}` : 'the record does not match the collection schema', errors);
        }
        throw err;
      }
    }
    return { line: row.line, doc };
  });
}

/** Upper bound of one owner's page (query_data caps lower itself). */
const OWNER_MAX_LIMIT = 200;

export const recordsAuthority: RecordsAuthority<DataConfig> = {
  async collections(view: RecordsView<DataConfig>) {
    const counts = await countsByCollection(view.db, view.app.id);
    return Object.keys(view.config.collections)
      .sort()
      .map((name) => describe(name, view.config.collections[name], counts.get(name) ?? 0));
  },

  async query(view: RecordsView<DataConfig>, q: RecordsQuery) {
    const c = requireCollection(view.config, q.collection);
    const page = await pageOf(view.db, view.app.id, q.collection, c, q, { ownerId: null, maxLimit: OWNER_MAX_LIMIT, withTotal: true });
    const counts = await countsByCollection(view.db, view.app.id);
    return {
      collection: describe(q.collection, c, counts.get(q.collection) ?? 0),
      records: page.records,
      total: page.total ?? 0,
      next_cursor: page.next_cursor,
    };
  },

  async get(view, collection, id) {
    requireCollection(view.config, collection);
    const row = await loadRecord(view.db, view.app.id, collection, id);
    return row ? toRecord(row) : null;
  },

  async remove(view, collection, id) {
    requireCollection(view.config, collection);
    return deleteRecord(view.db, view.app.id, collection, id);
  },

  csv(view, q) {
    const c = requireCollection(view.config, q.collection);
    return csvLines(view.db, view.app.id, q.collection, c, q);
  },

  async update(view, collection, id, fields) {
    const c = requireCollection(view.config, collection);
    const row = await loadRecord(view.db, view.app.id, collection, id);
    if (!row) return null;
    const doc = ownFields(fields);
    if (c.schema) validateDocument(c.schema, doc);
    // The owner's edit replaces the fields wholesale; patchRecord re-checks the row under the write lock (NSO-322).
    const updated = await patchRecord(view.db, { appId: view.app.id, collection, id, next: () => doc, limits: dataQuotaFromLimits(await view.limits()) });
    return updated ? toRecord(updated) : null;
  },

  // The owner's import skips DATA_WRITE_RATE_LIMIT (one authorized batch, not
  // app traffic) but never the quota: the batch fits as a whole or nothing is stored.
  async importCsv(view, collection, text) {
    const c = requireCollection(view.config, collection);
    const rows = importDocs(c, text);
    const limits = dataQuotaFromLimits(await view.limits());
    for (const r of rows) {
      const bytes = docByteSize(r.doc);
      if (bytes > limits.maxDocBytes) throw rowError(r.line, `the record is ${bytes} bytes; one record may have at most ${limits.maxDocBytes}`);
    }
    const imported = await insertRecords(view.db, { appId: view.app.id, collection, docs: rows.map((r) => r.doc), limits });
    return { imported };
  },

  async dropCollection(view, collection) {
    requireCollection(view.config, collection);
    const records = await deleteCollectionRecords(view.db, view.app.id, collection);
    return { records, configPatch: { collections: { [collection]: null } } };
  },
};
