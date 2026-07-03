/**
 * Member-view data reads for the dashboard Data tab (M1b, PHY-121) — the app
 * OWNER'S view of its own data. Distinct from the U10 public/anon path: a
 * workspace MEMBER (viewer+) may read EVERY collection of their app REGARDLESS
 * of its access_mode, and an editor+ may delete a record. The public/anon
 * access-mode gate (records.server `prepare` → decideDataAccess) does NOT run
 * here; the gate is workspace MEMBERSHIP + role (decideMemberDataAccess).
 *
 * Tenant isolation is still enforced: the caller passes the workspace id it
 * resolved from its own session membership (requireWorkspaceRole), and resolveApp
 * rejects a cross-workspace locator (not_found) before any row is touched.
 *
 * Every read routes through the SAME query builder + soft-delete as the public
 * path (executeQuery / softDeleteById in records.server) — no second query path.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { appDocuments, collections as collectionsTable, getDb } from '@drobek/db';
import type { WorkspaceRole } from '@drobek/tenancy/roles';
import {
  decideMemberDataAccess,
  type AccessMode,
  type DataOperation,
} from './access.js';
import { getCollection, type CollectionRow } from './collections.server.js';
import { schemaSummary } from './columns.js';
import { DataError } from './errors.js';
import {
  executeQuery,
  loadLive,
  softDeleteById,
  toRecord,
  type DataRecord,
  type QueryOptions,
  type QueryResult,
} from './records.server.js';
import { resolveApp, type ResolvedApp } from './resolve.server.js';

export interface MemberDataContext {
  wsSlug: string;
  appSlug: string;
  /** The workspace id resolved from the caller's session membership. */
  workspaceId: string;
  /** The caller's effective role in that workspace (null ⇒ non-member ⇒ denied). */
  role: WorkspaceRole | null;
}

export interface MemberCollectionSummary {
  name: string;
  recordCount: number;
  accessMode: AccessMode;
  schemaSummary: string;
}

/** Gate on membership/role, then resolve the app under the caller's workspace. */
async function resolveForMember(
  ctx: MemberDataContext,
  operation: DataOperation
): Promise<ResolvedApp> {
  if (!decideMemberDataAccess({ role: ctx.role, operation })) {
    throw new DataError('forbidden', 'you do not have permission to do that');
  }
  return resolveApp({
    wsSlug: ctx.wsSlug,
    appSlug: ctx.appSlug,
    requireWorkspaceId: ctx.workspaceId,
  });
}

/** Resolve the app + the named collection, member-gated. */
async function prepareMember(
  ctx: MemberDataContext,
  collection: string,
  operation: DataOperation
): Promise<{ app: ResolvedApp; collection: CollectionRow }> {
  const app = await resolveForMember(ctx, operation);
  const row = await getCollection(app.appId, collection);
  return { app, collection: row };
}

/** Live (non-deleted) document counts per collection for one app. */
async function liveCounts(appId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({
      collection: appDocuments.collection,
      n: sql<string>`count(*)`,
    })
    .from(appDocuments)
    .where(and(eq(appDocuments.appId, appId), isNull(appDocuments.deletedAt)))
    .groupBy(appDocuments.collection);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.collection, Number(r.n));
  return m;
}

/**
 * The app's collections for the dashboard list: name, live record count, access
 * mode, and a short schema summary. viewer+ member (any access mode).
 */
export async function listCollectionsForMember(
  ctx: MemberDataContext
): Promise<MemberCollectionSummary[]> {
  const app = await resolveForMember(ctx, 'read');
  const rows = await getDb()
    .select({
      name: collectionsTable.name,
      jsonSchema: collectionsTable.jsonSchema,
      accessMode: collectionsTable.accessMode,
    })
    .from(collectionsTable)
    .where(eq(collectionsTable.appId, app.appId))
    .orderBy(collectionsTable.name);
  const counts = await liveCounts(app.appId);
  return rows.map((r) => ({
    name: r.name,
    recordCount: counts.get(r.name) ?? 0,
    accessMode: r.accessMode as AccessMode,
    schemaSummary: schemaSummary(r.jsonSchema),
  }));
}

export interface MemberCollection {
  name: string;
  accessMode: AccessMode;
  jsonSchema: unknown;
}

/** The collection's schema + access mode + rows, member-gated (viewer+). */
export async function queryRecordsForMember(
  ctx: MemberDataContext,
  collection: string,
  opts: QueryOptions
): Promise<{ collection: MemberCollection; result: QueryResult }> {
  const { app, collection: row } = await prepareMember(ctx, collection, 'read');
  const result = await executeQuery(app, row, opts);
  return {
    collection: {
      name: row.name,
      accessMode: row.accessMode,
      jsonSchema: row.jsonSchema,
    },
    result,
  };
}

/** A single record for the read-only JSON viewer, member-gated (viewer+). */
export async function readRecordForMember(
  ctx: MemberDataContext,
  collection: string,
  id: string
): Promise<DataRecord> {
  const { app, collection: row } = await prepareMember(ctx, collection, 'read');
  const found = await loadLive(app.appId, row.name, id);
  return toRecord(found, row.name);
}

/** Soft-delete a record, member-gated (editor+ via the 'write' operation). */
export async function deleteRecordForMember(
  ctx: MemberDataContext,
  collection: string,
  id: string
): Promise<{ id: string; deleted: true }> {
  const { app, collection: row } = await prepareMember(ctx, collection, 'write');
  return softDeleteById(app.appId, row.name, id);
}

/**
 * Iterate an ENTIRE collection (current filter/sort applied) in keyset pages for
 * the CSV export — bounded memory (one page at a time, never the whole set).
 * member-gated (viewer+). Caps total pages defensively so a pathological dataset
 * cannot stream unbounded.
 */
export async function* iterateRecordsForMember(
  ctx: MemberDataContext,
  collection: string,
  opts: { where?: unknown; sort?: unknown; pageSize?: number }
): AsyncGenerator<DataRecord[]> {
  const { app, collection: row } = await prepareMember(ctx, collection, 'read');
  const pageSize = opts.pageSize ?? 200;
  let cursor: string | null = null;
  let pages = 0;
  const MAX_PAGES = 10_000; // 10k pages * 200 = 2M rows hard ceiling.
  do {
    const result = await executeQuery(app, row, {
      where: opts.where,
      sort: opts.sort,
      limit: pageSize,
      cursor: cursor ?? undefined,
    });
    if (result.records.length > 0) yield result.records;
    cursor = result.nextCursor;
  } while (cursor && ++pages < MAX_PAGES);
}

/** The schema of a collection (for CSV columns), member-gated (viewer+). */
export async function getCollectionForMember(
  ctx: MemberDataContext,
  collection: string
): Promise<MemberCollection> {
  const { collection: row } = await prepareMember(ctx, collection, 'read');
  return {
    name: row.name,
    accessMode: row.accessMode,
    jsonSchema: row.jsonSchema,
  };
}
