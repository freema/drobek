/**
 * `mod_data_documents` reads and writes. EVERY statement is scoped by the app
 * id the caller passes (the runtime scoped the request to ONE app) — and by
 * the collection — so no request can reach another app's records, whatever
 * collection name or record id it guesses. Field names and values from a
 * query are always bound parameters (query-build.ts validated them first).
 *
 * Writes of one app are serialized by a transaction-scoped advisory lock, so
 * the quota (records and bytes per app) holds under concurrency.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DB } from '@drobek/db';
import type { Condition, CursorState, ScalarValue, SortSpec } from './query-build.js';
import { encodeCursor } from './query-build.js';
import { DataError } from './errors.js';
import { docByteSize, enforceWriteQuota, type DataQuotaLimits } from './quota.js';
import { dataRecords, type DataRecordRow } from './schema.js';

/** A record as every API returns it: the server's fields first, then the record's own. */
export type DataRecord = { _id: string; _owner: string | null; _created_at: string; _updated_at: string } & Record<string, unknown>;

const SYSTEM_FIELDS = new Set(['_id', '_owner', '_created_at', '_updated_at']);

export function toRecord(row: Pick<DataRecordRow, 'id' | 'ownerId' | 'doc' | 'createdAt' | 'updatedAt'>): DataRecord {
  const out: DataRecord = {
    _id: row.id,
    _owner: row.ownerId,
    _created_at: row.createdAt.toISOString(),
    _updated_at: row.updatedAt.toISOString(),
  };
  for (const [k, v] of Object.entries(row.doc ?? {})) if (!SYSTEM_FIELDS.has(k)) out[k] = v;
  return out;
}

function newRecordId(): string {
  return createId();
}

function scope(appId: string, collection: string): SQL {
  return and(eq(dataRecords.appId, appId), eq(dataRecords.collection, collection))!;
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

/** Run `fn` in a transaction holding this app's data write lock. */
async function withAppWriteLock<T>(db: DB, appId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:mod_data:${appId}`}::text))`);
    return fn(tx);
  });
}

async function usage(tx: Tx | DB, appId: string, excludeId?: string): Promise<{ count: number; bytes: number }> {
  const where = excludeId
    ? and(eq(dataRecords.appId, appId), sql`${dataRecords.id} <> ${excludeId}::text`)
    : eq(dataRecords.appId, appId);
  const [row] = await tx
    .select({ n: sql<string>`count(*)`, b: sql<string>`coalesce(sum(${dataRecords.bytes}), 0)` })
    .from(dataRecords)
    .where(where);
  return { count: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
}

export async function countRecords(db: DB, appId: string, collection: string): Promise<number> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(dataRecords).where(scope(appId, collection));
  return Number(row?.n ?? 0);
}

/** Stored records per collection of one app. */
export async function countsByCollection(db: DB, appId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ collection: dataRecords.collection, n: sql<string>`count(*)` })
    .from(dataRecords)
    .where(eq(dataRecords.appId, appId))
    .groupBy(dataRecords.collection);
  return new Map(rows.map((r) => [r.collection, Number(r.n)]));
}

export async function insertRecord(
  db: DB,
  input: { appId: string; collection: string; ownerId: string | null; doc: Record<string, unknown>; limits: DataQuotaLimits }
): Promise<DataRecordRow> {
  const bytes = docByteSize(input.doc);
  return withAppWriteLock(db, input.appId, async (tx) => {
    const u = await usage(tx, input.appId);
    enforceWriteQuota({ limits: input.limits, newDocBytes: bytes, liveDocCount: u.count, liveBytesExcludingTarget: u.bytes, isCreate: true });
    // A JS timestamp (millisecond precision): cursors compare it exactly.
    const now = new Date();
    const [row] = await tx
      .insert(dataRecords)
      .values({ id: newRecordId(), appId: input.appId, collection: input.collection, ownerId: input.ownerId, doc: input.doc, bytes, createdAt: now, updatedAt: now })
      .returning();
    return row;
  });
}

export async function loadRecord(db: DB, appId: string, collection: string, id: string): Promise<DataRecordRow | null> {
  const [row] = await db
    .select()
    .from(dataRecords)
    .where(and(scope(appId, collection), eq(dataRecords.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Update a record from its CURRENT fields (NSO-322 M1): the row is re-read
 * `FOR UPDATE` inside the app's write lock, `next(doc)` builds the new fields
 * from it (merge + validate — a throw rolls back), then the quota check and
 * the UPDATE. Two concurrent PATCHes of one record therefore both land
 * instead of the later one overwriting the earlier with a stale merge. null
 * when the record no longer exists.
 */
export async function patchRecord(
  db: DB,
  input: {
    appId: string;
    collection: string;
    id: string;
    next: (doc: Record<string, unknown>) => Record<string, unknown>;
    limits: DataQuotaLimits;
  }
): Promise<DataRecordRow | null> {
  return withAppWriteLock(db, input.appId, async (tx) => {
    const [current] = await tx
      .select()
      .from(dataRecords)
      .where(and(scope(input.appId, input.collection), eq(dataRecords.id, input.id)))
      .limit(1)
      .for('update');
    if (!current) return null;
    const doc = input.next({ ...(current.doc ?? {}) });
    const bytes = docByteSize(doc);
    const u = await usage(tx, input.appId, input.id);
    enforceWriteQuota({ limits: input.limits, newDocBytes: bytes, liveDocCount: u.count, liveBytesExcludingTarget: u.bytes, isCreate: false });
    const [row] = await tx
      .update(dataRecords)
      .set({ doc, bytes, updatedAt: new Date() })
      .where(and(scope(input.appId, input.collection), eq(dataRecords.id, input.id)))
      .returning();
    return row ?? null;
  });
}

/**
 * Insert many records at once (the owner's CSV import): ONE transaction under
 * the app's write lock, the quota checked for the whole batch first — either
 * every record is stored or none. `created_at` rises by a millisecond per
 * record, so the file's order is the creation order.
 */
export async function insertRecords(
  db: DB,
  input: { appId: string; collection: string; docs: Record<string, unknown>[]; limits: DataQuotaLimits }
): Promise<number> {
  const sized = input.docs.map((doc) => ({ doc, bytes: docByteSize(doc) }));
  return withAppWriteLock(db, input.appId, async (tx) => {
    const u = await usage(tx, input.appId);
    const total = sized.reduce((a, d) => a + d.bytes, 0);
    for (const d of sized) {
      enforceWriteQuota({ limits: input.limits, newDocBytes: d.bytes, liveDocCount: 0, liveBytesExcludingTarget: 0, isCreate: false });
    }
    if (u.count + sized.length > input.limits.maxDocsPerApp) {
      throw new DataError(
        'quota_exceeded',
        `The import would store ${u.count + sized.length} records; this app may store at most ${input.limits.maxDocsPerApp} (${u.count} stored).`,
        { details: { limit: 'DATA_MAX_DOCS_PER_APP', value: input.limits.maxDocsPerApp } }
      );
    }
    enforceWriteQuota({ limits: input.limits, newDocBytes: total, liveDocCount: 0, liveBytesExcludingTarget: u.bytes, isCreate: false });
    const base = Date.now();
    for (let i = 0; i < sized.length; i += 500) {
      const chunk = sized.slice(i, i + 500).map((d, j) => {
        const at = new Date(base + i + j);
        return { id: newRecordId(), appId: input.appId, collection: input.collection, ownerId: null, doc: d.doc, bytes: d.bytes, createdAt: at, updatedAt: at };
      });
      await tx.insert(dataRecords).values(chunk);
    }
    return sized.length;
  });
}

/** Delete every record of one collection of an app; how many were deleted. */
export async function deleteCollectionRecords(db: DB, appId: string, collection: string): Promise<number> {
  const rows = await db.delete(dataRecords).where(scope(appId, collection)).returning({ id: dataRecords.id });
  return rows.length;
}

export async function deleteRecord(db: DB, appId: string, collection: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(dataRecords)
    .where(and(scope(appId, collection), eq(dataRecords.id, id)))
    .returning({ id: dataRecords.id });
  return rows.length > 0;
}

// ── queries ─────────────────────────────────────────────────────────────────

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/** `field = value`, NULL-safe (never NULL itself). A string matches the field's text form (so "true" matches true). */
function eqSql(field: string, value: ScalarValue): SQL {
  const f = sql`(${dataRecords.doc} -> ${field}::text)`;
  if (value === null) return sql`(${f} IS NULL OR ${f} = 'null'::jsonb)`;
  if (typeof value === 'string') return sql`coalesce((${dataRecords.doc} ->> ${field}::text) = ${value}::text, false)`;
  return sql`coalesce(${f} = ${jsonb(value)}, false)`;
}

function compareSql(field: string, op: 'gt' | 'gte' | 'lt' | 'lte', value: string | number): SQL {
  const sym = sql.raw({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]);
  const f = sql`(${dataRecords.doc} -> ${field}::text)`;
  if (typeof value === 'number') return sql`(jsonb_typeof(${f}) = 'number' AND ${f} ${sym} ${jsonb(value)})`;
  return sql`(jsonb_typeof(${f}) = 'string' AND (${dataRecords.doc} ->> ${field}::text) ${sym} ${value}::text)`;
}

function containsSql(field: string, value: ScalarValue): SQL {
  const f = sql`(${dataRecords.doc} -> ${field}::text)`;
  const inArray = sql`(jsonb_typeof(${f}) = 'array' AND ${f} @> ${jsonb([value])})`;
  if (typeof value !== 'string') return inArray;
  return sql`(${inArray} OR (jsonb_typeof(${f}) = 'string' AND strpos(lower(${dataRecords.doc} ->> ${field}::text), lower(${value}::text)) > 0))`;
}

function conditionSql(c: Condition): SQL {
  switch (c.op) {
    case 'eq':
      return eqSql(c.field, c.value as ScalarValue);
    case 'ne':
      return sql`NOT ${eqSql(c.field, c.value as ScalarValue)}`;
    case 'in':
      return sql`(${sql.join((c.value as ScalarValue[]).map((v) => eqSql(c.field, v)), sql` OR `)})`;
    case 'contains':
      return containsSql(c.field, c.value as ScalarValue);
    default:
      return compareSql(c.field, c.op, c.value as string | number);
  }
}

/** The ordering value as jsonb (total order: missing fields sort as JSON null). */
function orderExpr(sort: SortSpec): SQL {
  if (sort.meta) {
    if (sort.field === '_id') return sql`to_jsonb(${dataRecords.id})`;
    const col = sort.field === '_updated_at' ? dataRecords.updatedAt : dataRecords.createdAt;
    return sql`to_jsonb(extract(epoch from ${col}))`;
  }
  return sql`coalesce(${dataRecords.doc} -> ${sort.field}::text, 'null'::jsonb)`;
}

export interface QueryInput {
  appId: string;
  collection: string;
  /** Only this owner's records (a `read: owner` list), or null for all. */
  ownerId: string | null;
  conditions: Condition[];
  sort: SortSpec;
  limit: number;
  cursor: CursorState | null;
}

function whereOf(input: Omit<QueryInput, 'sort' | 'limit' | 'cursor'>): SQL[] {
  const conds: SQL[] = [scope(input.appId, input.collection)];
  if (input.ownerId !== null) conds.push(eq(dataRecords.ownerId, input.ownerId));
  for (const c of input.conditions) conds.push(conditionSql(c));
  return conds;
}

/** One keyset page (newest first by default) and the cursor of the next one. */
export async function queryRecords(db: DB, input: QueryInput): Promise<{ rows: DataRecordRow[]; nextCursor: string | null }> {
  const expr = orderExpr(input.sort);
  const conds = whereOf(input);
  if (input.cursor) {
    const v = input.cursor.v ?? 'null';
    const cmp = sql.raw(input.sort.dir === 'asc' ? '>' : '<');
    conds.push(sql`(${expr}, ${dataRecords.id}) ${cmp} (${v}::jsonb, ${input.cursor.i}::text)`);
  }
  const dir = sql.raw(input.sort.dir === 'asc' ? 'ASC' : 'DESC');
  const rows = await db
    .select({
      id: dataRecords.id,
      appId: dataRecords.appId,
      collection: dataRecords.collection,
      ownerId: dataRecords.ownerId,
      doc: dataRecords.doc,
      bytes: dataRecords.bytes,
      createdAt: dataRecords.createdAt,
      updatedAt: dataRecords.updatedAt,
      cursorValue: sql<string>`(${expr})::text`,
    })
    .from(dataRecords)
    .where(and(...conds))
    .orderBy(sql`${expr} ${dir}`, sql`${dataRecords.id} ${dir}`)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map(({ cursorValue: _c, ...row }) => row),
    nextCursor: hasMore && last ? encodeCursor({ v: last.cursorValue ?? null, i: last.id }) : null,
  };
}

/** How many records match (all pages). */
export async function countMatching(db: DB, input: Omit<QueryInput, 'sort' | 'limit' | 'cursor'>): Promise<number> {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(dataRecords).where(and(...whereOf(input)));
  return Number(row?.n ?? 0);
}
