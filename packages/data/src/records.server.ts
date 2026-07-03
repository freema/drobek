/**
 * Record CRUD + query (U10, PHY-55/PHY-56). Every operation:
 *   1. resolves the app (tenant-scoped) + the collection,
 *   2. rejects owner-only as not_implemented (deferred to U11 end-user auth),
 *   3. enforces the collection ACCESS MODE for the caller,
 *   4. (writes) validates the doc/patch against the collection JSON Schema,
 *      consumes a write rate-limit token, and enforces the storage quota,
 *   5. soft-deletes on delete; excludes soft-deleted rows from every read/query.
 *
 * Tenant isolation: EVERY db statement is scoped `WHERE app_id = <resolved> AND
 * collection = <name>` — the client never supplies a raw app/workspace id, and
 * `where`/`sort` fields are whitelisted to the schema (see query-build.ts).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appDocuments, getDb } from '@drobek/db';
import { decideDataAccess, type DataCaller, type DataOperation } from './access.js';
import { getCollection, type CollectionRow } from './collections.server.js';
import { DataError } from './errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  normalizeSort,
  normalizeWhere,
  type SortSpec,
} from './query-build.js';
import { dataQuotaFromEnv, docByteSize, enforceWriteQuota } from './quota.js';
import { enforceWriteRateLimit } from './rate-limit.js';
import { resolveApp, type ResolvedApp } from './resolve.server.js';
import { schemaPropertyNames, validateDocument } from './schema-validate.js';

export interface DataLocator {
  wsSlug: string;
  appSlug: string;
  /** MCP path only: the token's bound workspace id (cross-workspace guard). */
  requireWorkspaceId?: string;
}

export interface RecordContext {
  locator: DataLocator;
  collection: string;
  caller: DataCaller;
}

export interface DataRecord {
  id: string;
  collection: string;
  doc: unknown;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: {
  id: string;
  doc: unknown;
  createdAt: Date;
  updatedAt: Date;
}, collection: string): DataRecord {
  return {
    id: row.id,
    collection,
    doc: row.doc,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Resolve app + collection and enforce owner-only + the access mode. */
async function prepare(
  ctx: RecordContext,
  operation: DataOperation
): Promise<{ app: ResolvedApp; collection: CollectionRow }> {
  const app = await resolveApp({
    wsSlug: ctx.locator.wsSlug,
    appSlug: ctx.locator.appSlug,
    requireWorkspaceId: ctx.locator.requireWorkspaceId,
  });
  const collection = await getCollection(app.appId, ctx.collection);

  if (collection.accessMode === 'owner-only') {
    throw new DataError(
      'not_implemented',
      'owner-only collections require hosted-app end-user auth, which lands in U11; not available yet'
    );
  }

  const decision = decideDataAccess({
    accessMode: collection.accessMode,
    operation,
    caller: ctx.caller,
  });
  if (!decision.ok) {
    throw decision.status === 401
      ? new DataError('unauthorized', 'authentication required for this collection')
      : new DataError('forbidden', 'you do not have permission to do that');
  }
  return { app, collection };
}

/** Count live (non-deleted) documents across the whole app. */
async function liveDocCount(appId: string): Promise<number> {
  const rows = await getDb()
    .select({ v: sql<string>`count(*)` })
    .from(appDocuments)
    .where(and(eq(appDocuments.appId, appId), isNull(appDocuments.deletedAt)));
  return Number(rows[0]?.v ?? 0);
}

/** Sum stored bytes of live docs across the app, optionally excluding one id. */
async function liveDocBytes(appId: string, excludeId?: string): Promise<number> {
  const conds = [eq(appDocuments.appId, appId), isNull(appDocuments.deletedAt)];
  if (excludeId) conds.push(sql`${appDocuments.id} <> ${excludeId}`);
  const rows = await getDb()
    .select({
      v: sql<string>`coalesce(sum(octet_length(${appDocuments.doc}::text)), 0)`,
    })
    .from(appDocuments)
    .where(and(...conds));
  return Number(rows[0]?.v ?? 0);
}

export async function createRecord(
  ctx: RecordContext & { doc: unknown }
): Promise<DataRecord> {
  const { collection, app } = await prepare(ctx, 'write');
  validateDocument(collection.jsonSchema, ctx.doc);

  await enforceWriteRateLimit(app.appId);

  const limits = dataQuotaFromEnv();
  const newDocBytes = docByteSize(ctx.doc);
  enforceWriteQuota({
    limits,
    newDocBytes,
    liveDocCount: await liveDocCount(app.appId),
    liveBytesExcludingTarget: await liveDocBytes(app.appId),
    isCreate: true,
  });

  const [row] = await getDb()
    .insert(appDocuments)
    .values({ appId: app.appId, collection: collection.name, doc: ctx.doc })
    .returning({
      id: appDocuments.id,
      doc: appDocuments.doc,
      createdAt: appDocuments.createdAt,
      updatedAt: appDocuments.updatedAt,
    });
  return toRecord(row, collection.name);
}

/** Load a live document scoped to the app + collection, or throw not_found. */
async function loadLive(appId: string, collection: string, id: string) {
  const rows = await getDb()
    .select({
      id: appDocuments.id,
      doc: appDocuments.doc,
      createdAt: appDocuments.createdAt,
      updatedAt: appDocuments.updatedAt,
    })
    .from(appDocuments)
    .where(
      and(
        eq(appDocuments.id, id),
        eq(appDocuments.appId, appId),
        eq(appDocuments.collection, collection),
        isNull(appDocuments.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new DataError('not_found', 'document not found');
  return row;
}

export async function readRecord(
  ctx: RecordContext & { id: string }
): Promise<DataRecord> {
  const { app, collection } = await prepare(ctx, 'read');
  const row = await loadLive(app.appId, collection.name, ctx.id);
  return toRecord(row, collection.name);
}

export async function updateRecord(
  ctx: RecordContext & { id: string; patch: unknown }
): Promise<DataRecord> {
  const { app, collection } = await prepare(ctx, 'write');
  if (
    typeof ctx.patch !== 'object' ||
    ctx.patch === null ||
    Array.isArray(ctx.patch)
  ) {
    throw new DataError('invalid_request', 'patch must be a JSON object');
  }

  const existing = await loadLive(app.appId, collection.name, ctx.id);
  const merged = {
    ...(existing.doc as Record<string, unknown>),
    ...(ctx.patch as Record<string, unknown>),
  };
  validateDocument(collection.jsonSchema, merged);

  await enforceWriteRateLimit(app.appId);

  const limits = dataQuotaFromEnv();
  enforceWriteQuota({
    limits,
    newDocBytes: docByteSize(merged),
    liveDocCount: await liveDocCount(app.appId),
    liveBytesExcludingTarget: await liveDocBytes(app.appId, ctx.id),
    isCreate: false,
  });

  const [row] = await getDb()
    .update(appDocuments)
    .set({ doc: merged, updatedAt: new Date() })
    .where(eq(appDocuments.id, existing.id))
    .returning({
      id: appDocuments.id,
      doc: appDocuments.doc,
      createdAt: appDocuments.createdAt,
      updatedAt: appDocuments.updatedAt,
    });
  return toRecord(row, collection.name);
}

export async function deleteRecord(
  ctx: RecordContext & { id: string }
): Promise<{ id: string; deleted: true }> {
  const { app, collection } = await prepare(ctx, 'write');
  const existing = await loadLive(app.appId, collection.name, ctx.id);
  await enforceWriteRateLimit(app.appId);
  await getDb()
    .update(appDocuments)
    .set({ deletedAt: new Date() })
    .where(eq(appDocuments.id, existing.id));
  return { id: existing.id, deleted: true };
}

/** The raw ordering expression (pre-cast) for a resolved sort. */
function orderExpr(sort: SortSpec) {
  if (sort.meta) {
    if (sort.field === 'id') return sql`${appDocuments.id}`;
    if (sort.field === 'updatedAt') return sql`${appDocuments.updatedAt}`;
    return sql`${appDocuments.createdAt}`;
  }
  return sql`${appDocuments.doc} ->> ${sort.field}`;
}

export interface QueryResult {
  records: DataRecord[];
  nextCursor: string | null;
}

export async function queryRecords(
  ctx: RecordContext & {
    where?: unknown;
    sort?: unknown;
    limit?: unknown;
    cursor?: unknown;
  }
): Promise<QueryResult> {
  const { app, collection } = await prepare(ctx, 'read');
  const docFields = schemaPropertyNames(collection.jsonSchema);
  const where = normalizeWhere(ctx.where, docFields);
  const sort = normalizeSort(ctx.sort, docFields);
  const limit = clampLimit(ctx.limit);
  const cursor = decodeCursor(ctx.cursor);

  // NULL-safe, text-form ordering expression → deterministic keyset pagination.
  const orderText = sql`coalesce((${orderExpr(sort)})::text, '')`;

  const conds = [
    eq(appDocuments.appId, app.appId),
    eq(appDocuments.collection, collection.name),
    isNull(appDocuments.deletedAt),
  ];

  // Whitelisted equality filters — VALUES are parameterized (no injection).
  for (const w of where) {
    if (w.value === null) {
      conds.push(sql`${appDocuments.doc} ->> ${w.field} IS NULL`);
    } else {
      conds.push(sql`${appDocuments.doc} ->> ${w.field} = ${String(w.value)}`);
    }
  }

  // Keyset: rows strictly after the cursor in the (orderText, id) ordering.
  if (cursor) {
    const v = cursor.v ?? '';
    if (sort.dir === 'asc') {
      conds.push(
        sql`(${orderText} > ${v} OR (${orderText} = ${v} AND ${appDocuments.id} > ${cursor.i}))`
      );
    } else {
      conds.push(
        sql`(${orderText} < ${v} OR (${orderText} = ${v} AND ${appDocuments.id} < ${cursor.i}))`
      );
    }
  }

  const dir = sql.raw(sort.dir);
  const rows = await getDb()
    .select({
      id: appDocuments.id,
      doc: appDocuments.doc,
      createdAt: appDocuments.createdAt,
      updatedAt: appDocuments.updatedAt,
      cursorValue: sql<string>`${orderText}`,
    })
    .from(appDocuments)
    .where(and(...conds))
    .orderBy(sql`${orderText} ${dir}`, sql`${appDocuments.id} ${dir}`)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ v: last.cursorValue ?? '', i: last.id })
      : null;

  return {
    records: page.map((r) => toRecord(r, collection.name)),
    nextCursor,
  };
}
