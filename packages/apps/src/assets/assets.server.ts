/**
 * App assets (NSO-358): the rows (`app_assets`) and the bytes (disk.server.ts)
 * of the binary files an app serves at `/<name>` — the same URL space as its
 * files; an app file at the same path wins, so an upload to a path the app's
 * latest or published version occupies is refused (`asset_path_taken`).
 *
 * storeAsset streams an upload to disk — never buffering it — while it
 * counts the bytes (over APP_ASSET_MAX_BYTES or past the declared size → it
 * stops at once), hashes them and sniffs the type (no asset type → it stops
 * as soon as that is certain). Only a complete upload whose sniffed type fits
 * the name's extension is renamed into place; the row is then written under
 * a per-app advisory lock that re-checks the quota (APP_ASSETS_QUOTA, the
 * replaced asset's bytes excluded) against the real size, together with its
 * audit row. A replaced asset's old file is removed after the commit.
 *
 * Nothing here executes or parses the bytes beyond the signature check: the
 * server stores and serves them (hard rule 3).
 */
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit } from '@drobek/audit';
import { appAssets, appVersions, apps, getDb, versionFiles, type DB } from '@drobek/db';
import type { Actor } from '../types.js';
import type { AssetLimits } from './config.js';
import { assetDisk, newStorageKey, type AssetDisk } from './disk.server.js';
import { AssetsError } from './errors.js';
import { assetNameProblem, assetPath, assetTypesForName, declaredTypeFits, normalizeContentType, typeFamily } from './names.js';
import { AssetSniffer } from './sniff.js';

/** The app an asset operation acts on (resolved and authorized by the caller). */
export interface AssetApp {
  id: string;
  slug: string;
  workspaceId: string;
}

/** One asset as listed (dashboard, list_assets). */
export interface AssetInfo {
  name: string;
  path: string;
  type: string;
  size: number;
  sha256: string;
  updatedAt: Date;
}

/** What the app hosts need to serve an asset. */
export interface ServedAssetRow {
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  updatedAt: Date;
}

const MIB = 1024 * 1024;

function bytesText(n: number): string {
  if (n >= 1024 * MIB && n % (1024 * MIB) === 0) return `${n / (1024 * MIB)} GiB`;
  if (n >= MIB) return `${Math.round((n / MIB) * 10) / 10} MiB`;
  return `${n} bytes`;
}

function lockKey(appId: string): string {
  return `drobek:assets:${appId}`;
}

export async function listAssets(appId: string): Promise<AssetInfo[]> {
  const rows = await getDb()
    .select({
      name: appAssets.name,
      type: appAssets.contentType,
      size: appAssets.size,
      sha256: appAssets.sha256,
      updatedAt: appAssets.updatedAt,
    })
    .from(appAssets)
    .where(eq(appAssets.appId, appId))
    .orderBy(asc(appAssets.name));
  return rows.map((r) => ({ ...r, path: assetPath(r.name) }));
}

/** Bytes all assets of `appId` hold, optionally without the asset `exceptName`. */
export async function assetUsage(appId: string, exceptName?: string, executor: Pick<DB, 'select'> = getDb()): Promise<number> {
  const where = exceptName === undefined ? eq(appAssets.appId, appId) : and(eq(appAssets.appId, appId), ne(appAssets.name, exceptName));
  const [row] = await executor
    .select({ used: sql<string>`coalesce(sum(${appAssets.size}), 0)` })
    .from(appAssets)
    .where(where);
  return Number(row?.used ?? 0);
}

/** The asset `name` of `appId` as the app hosts serve it, or null. */
export async function findServedAsset(appId: string, name: string): Promise<ServedAssetRow | null> {
  const [row] = await getDb()
    .select({
      name: appAssets.name,
      contentType: appAssets.contentType,
      size: appAssets.size,
      sha256: appAssets.sha256,
      storageKey: appAssets.storageKey,
      updatedAt: appAssets.updatedAt,
    })
    .from(appAssets)
    .where(and(eq(appAssets.appId, appId), eq(appAssets.name, name)))
    .limit(1);
  return row ?? null;
}

function tooLarge(max: number): AssetsError {
  return new AssetsError('asset_too_large', `An asset may be at most ${bytesText(max)} (APP_ASSET_MAX_BYTES).`, {
    limit: 'APP_ASSET_MAX_BYTES',
    value: max,
  });
}

function overQuota(quota: number, used: number): AssetsError {
  return new AssetsError(
    'asset_quota_exceeded',
    `The app's assets would exceed ${bytesText(quota)} (APP_ASSETS_QUOTA; ${bytesText(used)} used). Delete assets you no longer need.`,
    { limit: 'APP_ASSETS_QUOTA', value: quota, used_bytes: used }
  );
}

function typeRefused(name: string, sniffed: string | null): AssetsError {
  const allowed = assetTypesForName(name) ?? [];
  return new AssetsError(
    'asset_type_not_allowed',
    sniffed
      ? `The bytes are ${sniffed}, which "${name}" cannot hold (allowed: ${allowed.join(', ')}).`
      : `The bytes are not an allowed asset type for "${name}" (allowed: ${allowed.join(', ')}); the type is decided from the file's content, not its name.`,
    { allowed, ...(sniffed ? { type: sniffed } : {}) }
  );
}

/**
 * Does a file of the app's latest or published version sit at `name`? That
 * file wins over an asset at the same path (the app hosts serve it first).
 */
export async function appFileAt(appId: string, name: string, executor: Pick<DB, 'select'> = getDb()): Promise<boolean> {
  const latest = executor
    .select({ n: sql<number>`max(${appVersions.number})` })
    .from(appVersions)
    .where(eq(appVersions.appId, appId));
  const published = executor.select({ id: apps.publishedVersionId }).from(apps).where(eq(apps.id, appId));
  const [hit] = await executor
    .select({ path: versionFiles.path })
    .from(versionFiles)
    .innerJoin(appVersions, eq(appVersions.id, versionFiles.versionId))
    .where(
      and(
        eq(appVersions.appId, appId),
        eq(versionFiles.path, name),
        or(eq(appVersions.number, latest), eq(appVersions.id, published))
      )
    )
    .limit(1);
  return hit !== undefined;
}

function pathTaken(name: string): AssetsError {
  return new AssetsError(
    'asset_path_taken',
    `The app already has a file at ${assetPath(name)} — an app file wins over an asset at the same path.`,
    { path: assetPath(name) }
  );
}

/**
 * The checks that need no bytes: a valid name no app file occupies, a declared type that fits it,
 * a positive size within APP_ASSET_MAX_BYTES and the app's quota (a replaced
 * asset's bytes do not count). Run before an upload URL is handed out and
 * again when the bytes arrive.
 */
export async function checkAssetUpload(input: {
  appId: string;
  name: string;
  size: number;
  contentType?: string | null;
  limits: AssetLimits;
}): Promise<void> {
  const problem = assetNameProblem(input.name);
  if (problem) throw new AssetsError('invalid_params', problem);
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new AssetsError('invalid_params', '`size` must be the exact file size in bytes (a positive whole number).');
  }
  if (input.contentType && !declaredTypeFits(input.name, input.contentType)) throw typeRefused(input.name, normalizeContentType(input.contentType));
  if (input.size > input.limits.maxBytes) throw tooLarge(input.limits.maxBytes);
  if (await appFileAt(input.appId, input.name)) throw pathTaken(input.name);
  const used = await assetUsage(input.appId, input.name);
  if (used + input.size > input.limits.quota) throw overQuota(input.limits.quota, used);
}

export interface StoreAssetInput {
  app: AssetApp;
  name: string;
  /** The bytes, streamed (an upload body). Abandoned early on a refusal. */
  body: AsyncIterable<Buffer>;
  /** The size the uploader declared; the body must be exactly that long. null = not known in advance. */
  size: number | null;
  /** The declared Content-Type; its family must match the sniffed type's. */
  contentType?: string | null;
  limits: AssetLimits;
  actor: Actor;
  /** Who handed out the upload URL, for the audit row: an MCP tool call or the dashboard. */
  via: 'mcp' | 'dashboard';
  disk?: AssetDisk;
}

export interface StoredAsset {
  name: string;
  path: string;
  size: number;
  type: string;
  sha256: string;
  replaced: boolean;
}

/** Stream, check and store one asset (see the file header). Throws AssetsError on every refusal. */
export async function storeAsset(input: StoreAssetInput): Promise<StoredAsset> {
  const { app, name, limits } = input;
  const disk = input.disk ?? assetDisk();
  const problem = assetNameProblem(name);
  if (problem) throw new AssetsError('invalid_params', problem);
  if (input.size !== null) await checkAssetUpload({ appId: app.id, name, size: input.size, contentType: input.contentType, limits });
  else {
    if (input.contentType && !declaredTypeFits(name, input.contentType)) throw typeRefused(name, normalizeContentType(input.contentType));
    if (await appFileAt(app.id, name)) throw pathTaken(name);
  }

  const allowed = assetTypesForName(name) ?? [];
  const writer = disk.begin();
  const sniffer = new AssetSniffer();
  let size = 0;
  let sha256: string;
  let type: string;
  try {
    for await (const chunk of input.body) {
      size += chunk.length;
      if (size > limits.maxBytes) throw tooLarge(limits.maxBytes);
      if (input.size !== null && size > input.size) {
        throw new AssetsError('asset_size_mismatch', `The upload is longer than the declared ${input.size} bytes.`, { declared: input.size });
      }
      sniffer.update(chunk);
      if (sniffer.rejected) throw typeRefused(name, null);
      await writer.write(chunk);
    }
    if (input.size !== null && size !== input.size) {
      throw new AssetsError('asset_size_mismatch', `The upload has ${size} bytes, the declared size was ${input.size}.`, {
        declared: input.size,
        received: size,
      });
    }
    const sniffed = sniffer.finish();
    if (!sniffed || !allowed.includes(sniffed)) throw typeRefused(name, sniffed);
    const declared = normalizeContentType(input.contentType);
    if (declared && declared !== 'application/octet-stream' && typeFamily(declared) !== typeFamily(sniffed)) {
      throw typeRefused(name, sniffed);
    }
    type = sniffed;
    sha256 = await writer.finish();
  } catch (err) {
    await writer.abort();
    throw err;
  }

  const key = newStorageKey();
  await writer.commit(app.id, key);
  let previousKey: string | null = null;
  try {
    previousKey = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(app.id)}::text))`);
      const [row] = await tx
        .select({ deletedAt: apps.deletedAt, lockedReason: apps.lockedReason })
        .from(apps)
        .where(eq(apps.id, app.id))
        .limit(1);
      if (!row || row.deletedAt) throw new AssetsError('not_found', 'The app no longer exists.');
      if (row.lockedReason) throw new AssetsError('app_locked_by_admin', 'This app was taken down by the server operator; its assets cannot change.');
      const [prev] = await tx
        .select({ storageKey: appAssets.storageKey })
        .from(appAssets)
        .where(and(eq(appAssets.appId, app.id), eq(appAssets.name, name)))
        .limit(1);
      const used = await assetUsage(app.id, name, tx);
      if (used + size > limits.quota) throw overQuota(limits.quota, used);
      const now = new Date();
      const values = {
        appId: app.id,
        name,
        contentType: type,
        size,
        sha256,
        storageKey: key,
        createdByUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      };
      await tx
        .insert(appAssets)
        .values(values)
        .onConflictDoUpdate({
          target: [appAssets.appId, appAssets.name],
          set: { contentType: type, size, sha256, storageKey: key, createdByUserId: input.actor.userId, updatedAt: now },
        });
      await writeAudit(
        {
          workspaceId: app.workspaceId,
          actorUserId: input.actor.userId,
          actorKind: input.actor.kind,
          action: AUDIT_ACTIONS.assetUpload,
          subjectType: 'app',
          target: app.slug,
          meta: { name, size, type, via: input.via, replaced: prev !== undefined },
        },
        tx
      );
      return prev?.storageKey ?? null;
    });
  } catch (err) {
    await disk.remove(app.id, key).catch(() => {});
    throw err;
  }
  if (previousKey) await disk.remove(app.id, previousKey).catch(() => {});
  return { name, path: assetPath(name), size, type, sha256, replaced: previousKey !== null };
}

/** Delete one asset (row, audit, then its file). false when there is no such asset. */
export async function deleteAsset(input: {
  app: AssetApp;
  name: string;
  actor: Actor;
  via: 'mcp' | 'dashboard';
  disk?: AssetDisk;
}): Promise<boolean> {
  const disk = input.disk ?? assetDisk();
  const removed = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(input.app.id)}::text))`);
    const [row] = await tx
      .delete(appAssets)
      .where(and(eq(appAssets.appId, input.app.id), eq(appAssets.name, input.name)))
      .returning({ storageKey: appAssets.storageKey, size: appAssets.size });
    if (!row) return null;
    await writeAudit(
      {
        workspaceId: input.app.workspaceId,
        actorUserId: input.actor.userId,
        actorKind: input.actor.kind,
        action: AUDIT_ACTIONS.assetDelete,
        subjectType: 'app',
        target: input.app.slug,
        meta: { name: input.name, size: row.size, via: input.via },
      },
      tx
    );
    return row;
  });
  if (!removed) return false;
  await disk.remove(input.app.id, removed.storageKey).catch(() => {});
  return true;
}
