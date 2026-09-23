/**
 * The query layer shared by the REST routes and the owner's view (the
 * `records` authority behind MCP `query_data` and the dashboard Data tab).
 *
 * The authority answers the app OWNER — core calls it only after it
 * authorized a drobek account for the app — so it bypasses the end-user rules;
 * it is still scoped to the ONE app of its view, and only to collections the
 * app's config declares (anything else → not_found).
 */
import type { DB } from '@drobek/db';
import type { RecordsAuthority, RecordsCollection, RecordsQuery, RecordsView } from '@drobek/modules';
import { schemaColumns, csvHeader, csvRecordLine } from './columns.js';
import { collectionConfig, rulesOf, type CollectionConfig, type DataConfig } from './config.js';
import { DataError } from './errors.js';
import { clampLimit, decodeCursor, normalizeFilter, normalizeSort, type Condition, type SortSpec } from './query-build.js';
import { schemaPropertyNames } from './schema-validate.js';
import { countMatching, countsByCollection, deleteRecord, loadRecord, queryRecords, toRecord, type DataRecord } from './store.js';

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
export function docFieldsOf(c: CollectionConfig): Set<string> | null {
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
export function sortOf(q: { sort?: string; dir?: 'asc' | 'desc' }, docFields: Set<string> | null): SortSpec {
  if (q.sort) return normalizeSort({ field: q.sort, dir: q.dir }, docFields);
  return normalizeSort(q.dir ? { field: '_created_at', dir: q.dir } : undefined, docFields);
}

export interface Normalized {
  conditions: Condition[];
  sort: SortSpec;
}

export function normalizeQuery(c: CollectionConfig, q: PageQuery): Normalized {
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
};
