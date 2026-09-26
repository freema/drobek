/**
 * Assets honour publish (NSO-362): the draft and the published snapshots.
 *
 *   - `app_assets` is the DRAFT — uploads, replacements and deletes change
 *     only it, and the preview host serves it.
 *   - `publish` FREEZES a set for the version it puts live
 *     (`app_version_assets` + `app_versions.assets_frozen_at`); the
 *     production host and custom domains serve only the live version's set,
 *     so an agent with `write` but no `publish` never changes a public URL.
 *     Publishing the version the preview shows (the newest one that
 *     compiled) freezes the draft; publishing an older version — the
 *     production rollback — brings back the set it had when it was last live
 *     (the draft when it has none).
 *   - `restore_version` of a version with a set resets the draft to that set,
 *     so the restored preview — and the publish after it — shows the version's
 *     old assets too.
 *
 * Bytes are content-addressed per app (`ASSETS_DIR/<app_id>/<sha256>`; rows
 * from before NSO-362 keep their random key) and never rewritten, so the
 * draft and any number of snapshots share one file. The quota
 * (APP_ASSETS_QUOTA) counts unique files: what the draft and the live set
 * need must fit it; the sets of earlier publishes (at most
 * ASSET_SNAPSHOTS_KEPT) are kept for a rollback only while everything fits,
 * the oldest dropped first. Files no row references go — at once when a
 * delete or replace frees them, else in the hourly sweep.
 *
 * Everything that changes the draft or the sets runs under the app's assets
 * advisory lock (`lockAssets`), after the app row lock where there is one.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { appAssets, appVersionAssets, appVersions, apps, getDb, type DB } from '@drobek/db';
import { assetDisk, type AssetDisk } from './disk.server.js';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
type Executor = Pick<DB, 'select' | 'execute'>;

/** How many earlier published versions keep their frozen assets for a rollback (besides the live one). */
export const ASSET_SNAPSHOTS_KEPT = 10;

/** Serialize every change of an app's assets for the rest of the transaction. */
export async function lockAssets(tx: Pick<DB, 'execute'>, appId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`drobek:assets:${appId}`}::text))`);
}

function rowsOf<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []);
}

/**
 * Bytes of the unique files the draft (without `exceptName`) and the live set
 * (`scope: 'live'`) or every kept set (`'all'`) reference, plus `extra`.
 */
export async function uniqueAssetBytes(
  ex: Pick<DB, 'execute'>,
  appId: string,
  o: { scope: 'live' | 'all'; exceptName?: string; extra?: { key: string; size: number } }
): Promise<number> {
  const draft =
    o.exceptName === undefined
      ? sql`SELECT storage_key, size FROM app_assets WHERE app_id = ${appId}`
      : sql`SELECT storage_key, size FROM app_assets WHERE app_id = ${appId} AND name <> ${o.exceptName}`;
  const frozen =
    o.scope === 'all'
      ? sql`SELECT storage_key, size FROM app_version_assets WHERE app_id = ${appId}`
      : sql`SELECT storage_key, size FROM app_version_assets WHERE app_id = ${appId}
              AND version_id = (SELECT published_version_id FROM apps WHERE id = ${appId})`;
  const extra = o.extra ? sql` UNION ALL SELECT ${o.extra.key}::text, ${o.extra.size}::bigint` : sql``;
  const res = await ex.execute(sql`
    SELECT coalesce(sum(size), 0)::text AS used FROM (
      SELECT storage_key, max(size) AS size FROM (${draft} UNION ALL ${frozen}${extra}) u GROUP BY storage_key
    ) d`);
  return Number(rowsOf<{ used: string }>(res)[0]?.used ?? 0);
}

/** A file the app already stores with these bytes (its key), or null. */
export async function storedKeyOf(ex: Executor, appId: string, sha256: string): Promise<string | null> {
  const [draft] = await ex
    .select({ key: appAssets.storageKey })
    .from(appAssets)
    .where(and(eq(appAssets.appId, appId), eq(appAssets.sha256, sha256)))
    .limit(1);
  if (draft) return draft.key;
  const [frozen] = await ex
    .select({ key: appVersionAssets.storageKey })
    .from(appVersionAssets)
    .where(and(eq(appVersionAssets.appId, appId), eq(appVersionAssets.sha256, sha256)))
    .limit(1);
  return frozen?.key ?? null;
}

async function dropSnapshot(tx: Tx, versionId: string): Promise<void> {
  await tx.delete(appVersionAssets).where(eq(appVersionAssets.versionId, versionId));
  await tx.update(appVersions).set({ assetsFrozenAt: null }).where(eq(appVersions.id, versionId));
}

/**
 * Drop earlier published sets (never the live one): beyond
 * ASSET_SNAPSHOTS_KEPT, then — with `quota` — the oldest until the draft,
 * the live set, the kept sets and `extra` fit it. Returns how many went.
 */
export async function pruneAssetSnapshots(
  tx: Tx,
  appId: string,
  o: { quota?: number; exceptName?: string; extra?: { key: string; size: number } } = {}
): Promise<number> {
  const [app] = await tx.select({ live: apps.publishedVersionId }).from(apps).where(eq(apps.id, appId)).limit(1);
  const live = app?.live ?? null;
  const older = await tx
    .select({ id: appVersions.id })
    .from(appVersions)
    .where(
      and(
        eq(appVersions.appId, appId),
        isNotNull(appVersions.assetsFrozenAt),
        ...(live ? [ne(appVersions.id, live)] : [])
      )
    )
    .orderBy(desc(appVersions.assetsFrozenAt), desc(appVersions.number));
  let dropped = 0;
  const kept = older.map((v) => v.id);
  while (kept.length > ASSET_SNAPSHOTS_KEPT) {
    await dropSnapshot(tx, kept.pop()!);
    dropped += 1;
  }
  if (o.quota !== undefined) {
    while (kept.length > 0 && (await uniqueAssetBytes(tx, appId, { scope: 'all', exceptName: o.exceptName, extra: o.extra })) > o.quota) {
      await dropSnapshot(tx, kept.pop()!);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Freeze the assets of `versionId`, which `publish` is putting live: the
 * draft when it is the version the preview shows (the newest that compiled)
 * or has no set yet; otherwise (a rollback) its own set stays. Either way it
 * becomes the most recent set; earlier ones beyond ASSET_SNAPSHOTS_KEPT go.
 */
export async function freezeAssetsForPublish(tx: Tx, appId: string, versionId: string): Promise<'draft' | 'kept'> {
  await lockAssets(tx, appId);
  const [head] = await tx
    .select({ id: appVersions.id })
    .from(appVersions)
    .where(and(eq(appVersions.appId, appId), eq(appVersions.compileStatus, 'ok')))
    .orderBy(desc(appVersions.number))
    .limit(1);
  const [version] = await tx
    .select({ frozenAt: appVersions.assetsFrozenAt })
    .from(appVersions)
    .where(eq(appVersions.id, versionId))
    .limit(1);
  const fromDraft = head?.id === versionId || !version?.frozenAt;
  if (fromDraft) {
    await tx.delete(appVersionAssets).where(eq(appVersionAssets.versionId, versionId));
    await tx.execute(sql`
      INSERT INTO app_version_assets (version_id, app_id, name, content_type, size, sha256, storage_key, updated_at)
      SELECT ${versionId}, app_id, name, content_type, size, sha256, storage_key, updated_at
      FROM app_assets WHERE app_id = ${appId}`);
  }
  await tx.update(appVersions).set({ assetsFrozenAt: new Date() }).where(eq(appVersions.id, versionId));
  return fromDraft ? 'draft' : 'kept';
}

/**
 * `restore_version`: reset the draft to the set `sourceVersionId` had when it
 * was last live. false (draft untouched) when it has none — never published,
 * or its set was pruned.
 */
export async function restoreDraftAssets(tx: Tx, appId: string, sourceVersionId: string, userId: string | null): Promise<boolean> {
  await lockAssets(tx, appId);
  const [source] = await tx
    .select({ frozenAt: appVersions.assetsFrozenAt })
    .from(appVersions)
    .where(eq(appVersions.id, sourceVersionId))
    .limit(1);
  if (!source?.frozenAt) return false;
  await tx.delete(appAssets).where(eq(appAssets.appId, appId));
  await tx.execute(sql`
    INSERT INTO app_assets (app_id, name, content_type, size, sha256, storage_key, created_by_user_id, created_at, updated_at)
    SELECT app_id, name, content_type, size, sha256, storage_key, ${userId}, now(), updated_at
    FROM app_version_assets WHERE version_id = ${sourceVersionId}`);
  return true;
}

/** Of `keys`, those no draft row or kept set of the app references. */
export async function unreferencedKeys(ex: Executor, appId: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const [draft, frozen] = await Promise.all([
    ex
      .select({ key: appAssets.storageKey })
      .from(appAssets)
      .where(and(eq(appAssets.appId, appId), inArray(appAssets.storageKey, keys))),
    ex
      .select({ key: appVersionAssets.storageKey })
      .from(appVersionAssets)
      .where(and(eq(appVersionAssets.appId, appId), inArray(appVersionAssets.storageKey, keys))),
  ]);
  const used = new Set([...draft, ...frozen].map((r) => r.key));
  return [...new Set(keys)].filter((k) => !used.has(k));
}

/**
 * Remove the files of `keys` that nothing references any more (under the
 * assets lock, so an upload reusing one cannot interleave). Best effort: a
 * failure leaves them to the sweep.
 */
export async function releaseAssetFiles(appId: string, keys: string[], disk: AssetDisk = assetDisk()): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getDb().transaction(async (tx) => {
      await lockAssets(tx, appId);
      for (const key of await unreferencedKeys(tx, appId, keys)) await disk.remove(appId, key);
    });
  } catch {
    // the sweep removes what is left
  }
}

/** The live published set's names the draft no longer has (they go with the next publish). */
export async function publishedOnlyAssetNames(appId: string): Promise<Array<{ name: string; contentType: string; size: number }>> {
  const draftNames = getDb().select({ name: appAssets.name }).from(appAssets).where(eq(appAssets.appId, appId));
  const live = getDb().select({ id: apps.publishedVersionId }).from(apps).where(eq(apps.id, appId));
  return getDb()
    .select({ name: appVersionAssets.name, contentType: appVersionAssets.contentType, size: appVersionAssets.size })
    .from(appVersionAssets)
    .where(and(eq(appVersionAssets.versionId, live), notInArray(appVersionAssets.name, draftNames)))
    .orderBy(asc(appVersionAssets.name));
}
