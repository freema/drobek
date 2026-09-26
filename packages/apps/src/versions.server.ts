/**
 * Immutable app versions (M0-02). Every write creates a new version whose
 * files point at content-addressed blobs, so identical content is stored once
 * no matter how many versions (or apps) contain it. Publishing moves one
 * pointer (`apps.published_version_id`); restore copies an old file list into
 * a NEW version, so history is never rewritten.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, writeAudit, type AuditExecutor } from '@drobek/audit';
import { normalizeAppPath } from '@drobek/compile';
import { appVersions, apps, blobs, getDb, versionFiles } from '@drobek/db';
import { AppsError } from './errors.js';
import { zipStream, type ZipEntry } from './zip.js';
import { lockedByAdminError, screenAfterPublish } from './moderation.server.js';
import type {
  Actor,
  CompileStatus,
  VersionDetail,
  VersionFile,
  VersionFileInput,
  VersionSummary,
} from './types.js';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export interface CreateVersionOptions {
  actor: Actor;
  /** The agent's one-line "why" (stored with the version, shown in history). */
  reasoning?: string | null;
  /** Compile result, when the caller already compiled (write_files does). */
  compile?: { status: CompileStatus; errors?: unknown };
}

const VERSION_COLUMNS = {
  id: appVersions.id,
  appId: appVersions.appId,
  number: appVersions.number,
  createdByUserId: appVersions.createdByUserId,
  actorKind: appVersions.actorKind,
  reasoning: appVersions.reasoning,
  compileStatus: appVersions.compileStatus,
  compileErrors: appVersions.compileErrors,
  createdAt: appVersions.createdAt,
};

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lock the app row for the rest of the transaction (serializes version numbers). */
async function lockApp(tx: Tx, appId: string) {
  const [app] = await tx
    .select({
      id: apps.id,
      slug: apps.slug,
      workspaceId: apps.workspaceId,
      publishedVersionId: apps.publishedVersionId,
      lockedReason: apps.lockedReason,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .for('update');
  if (!app) throw new AppsError('not_found', `App ${appId} does not exist.`);
  return app;
}

/** Lock the app row AND refuse when a super-admin took the app down (NSO-293). */
async function lockWritableApp(tx: Tx, appId: string) {
  const app = await lockApp(tx, appId);
  if (app.lockedReason !== null) throw lockedByAdminError(app.lockedReason);
  return app;
}

async function nextNumber(tx: Tx, appId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${appVersions.number})` })
    .from(appVersions)
    .where(eq(appVersions.appId, appId));
  return Number(row?.max ?? 0) + 1;
}

async function audit(
  tx: AuditExecutor,
  app: { workspaceId: string; slug: string },
  actor: Actor,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  await writeAudit(
    {
      workspaceId: app.workspaceId,
      actorUserId: actor.userId,
      actorKind: actor.kind,
      action,
      subjectType: 'app',
      target: app.slug,
      meta,
    },
    tx
  );
}

/**
 * Store a new version: blobs upsert → version row → file rows, in one
 * transaction. An upsert of an existing blob refreshes its `created_at` and
 * row-locks it, so a concurrent GC sweep can never delete it underneath us.
 */
export async function createVersion(
  appId: string,
  files: Iterable<VersionFileInput>,
  opts: CreateVersionOptions
): Promise<{ id: string; number: number }> {
  const rows: VersionFile[] = [];
  const bytesBySha = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const f of files) {
    const path = normalizeAppPath(f.path);
    if (!path) throw new AppsError('invalid_path', `Unsafe file path ${JSON.stringify(f.path)}.`);
    const kind = f.kind ?? 'source';
    if (seen.has(`${kind}:${path}`)) {
      throw new AppsError('invalid_path', `Duplicate ${kind} file "${path}".`);
    }
    seen.add(`${kind}:${path}`);
    const bytes = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    const sha256 = sha256Hex(bytes);
    bytesBySha.set(sha256, bytes);
    rows.push({ path, sha256, size: bytes.length, kind });
  }

  return getDb().transaction(async (tx) => {
    const app = await lockWritableApp(tx, appId);
    if (bytesBySha.size > 0) {
      await tx
        .insert(blobs)
        .values([...bytesBySha].map(([sha256, bytes]) => ({ sha256, bytes, size: bytes.length })))
        .onConflictDoUpdate({ target: blobs.sha256, set: { createdAt: sql`now()` } });
    }
    const number = await nextNumber(tx, appId);
    const [version] = await tx
      .insert(appVersions)
      .values({
        appId,
        number,
        createdByUserId: opts.actor.userId,
        actorKind: opts.actor.kind,
        reasoning: opts.reasoning ?? null,
        compileStatus: opts.compile?.status ?? 'pending',
        compileErrors: opts.compile?.errors ?? null,
      })
      .returning({ id: appVersions.id });
    if (rows.length > 0) {
      await tx.insert(versionFiles).values(rows.map((r) => ({ versionId: version.id, ...r })));
    }
    await audit(tx, app, opts.actor, AUDIT_ACTIONS.appVersionWrite, {
      version: number,
      files: rows.length,
    });
    return { id: version.id, number };
  });
}

/** One version of an app (by number or id) with its file list, or null. */
export async function getVersion(
  appId: string,
  ref: { number: number } | { id: string }
): Promise<VersionDetail | null> {
  const db = getDb();
  const [row] = await db
    .select({ ...VERSION_COLUMNS, publishedVersionId: apps.publishedVersionId })
    .from(appVersions)
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(
      and(
        eq(appVersions.appId, appId),
        'number' in ref ? eq(appVersions.number, ref.number) : eq(appVersions.id, ref.id)
      )
    )
    .limit(1);
  if (!row) return null;
  const files = await db
    .select({
      path: versionFiles.path,
      sha256: versionFiles.sha256,
      size: versionFiles.size,
      kind: versionFiles.kind,
    })
    .from(versionFiles)
    .where(eq(versionFiles.versionId, row.id))
    .orderBy(versionFiles.kind, versionFiles.path);
  const { publishedVersionId, ...version } = row;
  return { ...version, published: publishedVersionId === row.id, files };
}

/** The app's versions, newest first (no file lists). */
export async function listVersions(
  appId: string,
  opts: { limit?: number } = {}
): Promise<VersionSummary[]> {
  const rows = await getDb()
    .select({ ...VERSION_COLUMNS, publishedVersionId: apps.publishedVersionId })
    .from(appVersions)
    .innerJoin(apps, eq(apps.id, appVersions.appId))
    .where(eq(appVersions.appId, appId))
    .orderBy(desc(appVersions.number))
    .limit(opts.limit ?? 50);
  return rows.map(({ publishedVersionId, ...v }) => ({ ...v, published: publishedVersionId === v.id }));
}

/** The newest version's number (0 when the app has none). */
export async function latestVersionNumber(appId: string): Promise<number> {
  const [row] = await getDb()
    .select({ max: sql<number | null>`max(${appVersions.number})` })
    .from(appVersions)
    .where(eq(appVersions.appId, appId));
  return Number(row?.max ?? 0);
}

/** The bytes of one file of a version, or null when it has no such file. */
export async function readVersionFile(
  versionId: string,
  path: string,
  kind: 'source' | 'built' = 'source'
): Promise<Buffer | null> {
  const [row] = await getDb()
    .select({ bytes: blobs.bytes })
    .from(versionFiles)
    .innerJoin(blobs, eq(blobs.sha256, versionFiles.sha256))
    .where(
      and(
        eq(versionFiles.versionId, versionId),
        eq(versionFiles.path, path),
        eq(versionFiles.kind, kind)
      )
    )
    .limit(1);
  return row ? row.bytes : null;
}

/** Blob bytes by sha256 (the serving path caches these by hash). */
export async function readBlobs(sha256s: string[]): Promise<Map<string, Buffer>> {
  if (sha256s.length === 0) return new Map();
  const rows = await getDb()
    .select({ sha256: blobs.sha256, bytes: blobs.bytes })
    .from(blobs)
    .where(inArray(blobs.sha256, sha256s));
  return new Map(rows.map((r) => [r.sha256, r.bytes]));
}

/**
 * Point the app's production host at a version — one atomic pointer move,
 * audited as `app.publish` (with the previous version, so the audit log is
 * the publish history). Only a version that compiled `ok` is publishable.
 * A taken-down app (NSO-293) refuses with `app_locked_by_admin`. After the
 * pointer moved, the published version goes through the phishing heuristic
 * (`screen: false` skips it).
 */
export async function publish(
  appId: string,
  versionId: string,
  actor: Actor,
  opts: { screen?: boolean } = {}
): Promise<{ versionId: string; number: number; previousNumber: number | null }> {
  const result = await getDb().transaction(async (tx) => {
    const app = await lockWritableApp(tx, appId);
    const [version] = await tx
      .select({ id: appVersions.id, number: appVersions.number, status: appVersions.compileStatus })
      .from(appVersions)
      .where(and(eq(appVersions.id, versionId), eq(appVersions.appId, appId)));
    if (!version) throw new AppsError('not_found', `Version ${versionId} is not a version of this app.`);
    if (version.status !== 'ok') {
      throw new AppsError(
        'not_publishable',
        `Version ${version.number} did not compile (status: ${version.status}) — fix the errors and publish a version that compiles.`
      );
    }
    let previousNumber: number | null = null;
    if (app.publishedVersionId) {
      const [prev] = await tx
        .select({ number: appVersions.number })
        .from(appVersions)
        .where(eq(appVersions.id, app.publishedVersionId));
      previousNumber = prev?.number ?? null;
    }
    // published_at orders the public gallery (NSO-340); ms precision like its cursor.
    await tx.update(apps).set({ publishedVersionId: version.id, publishedAt: new Date() }).where(eq(apps.id, appId));
    await audit(tx, app, actor, AUDIT_ACTIONS.appPublish, {
      version: version.number,
      previousVersion: previousNumber,
    });
    return { versionId: version.id, number: version.number, previousNumber };
  });
  // NSO-293: the phishing heuristic — flags the app for the super-admin
  // queue, never blocks (a scan failure is only logged).
  if (opts.screen !== false) await screenAfterPublish(appId, result.versionId);
  return result;
}

/**
 * Restore = a NEW version with exactly the file list (and compile result) of
 * version `number`. Nothing is rewritten; publishing it is a separate step.
 */
export async function restore(
  appId: string,
  number: number,
  actor: Actor,
  opts: { reasoning?: string | null } = {}
): Promise<{ id: string; number: number }> {
  return getDb().transaction(async (tx) => {
    const app = await lockWritableApp(tx, appId);
    const [source] = await tx
      .select({
        id: appVersions.id,
        compileStatus: appVersions.compileStatus,
        compileErrors: appVersions.compileErrors,
      })
      .from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.number, number)));
    if (!source) throw new AppsError('not_found', `Version ${number} does not exist.`);

    const newNumber = await nextNumber(tx, appId);
    const [version] = await tx
      .insert(appVersions)
      .values({
        appId,
        number: newNumber,
        createdByUserId: actor.userId,
        actorKind: actor.kind,
        reasoning: opts.reasoning ?? `Restore of version ${number}`,
        compileStatus: source.compileStatus,
        compileErrors: source.compileErrors,
      })
      .returning({ id: appVersions.id });
    await tx.execute(sql`
      INSERT INTO ${versionFiles} (version_id, path, sha256, size, kind)
      SELECT ${version.id}, path, sha256, size, kind FROM ${versionFiles}
      WHERE version_id = ${source.id}`);
    await audit(tx, app, actor, AUDIT_ACTIONS.appVersionRestore, {
      version: newNumber,
      restoredFrom: number,
    });
    return { id: version.id, number: newNumber };
  });
}

const ZIP_BLOB_BATCH = 32;

/**
 * A version as a ZIP (the dashboard's "download", NSO-288): every source file
 * under `<slug>-v<N>/source/`, every compiled output under
 * `<slug>-v<N>/built/`. Streamed — blobs are read in small batches while the
 * archive is written. null when the app has no such version.
 */
export async function versionZip(
  app: { id: string; slug: string },
  number: number
): Promise<{ filename: string; stream: AsyncGenerator<Buffer> } | null> {
  const version = await getVersion(app.id, { number });
  if (!version) return null;
  const root = `${app.slug}-v${version.number}`;
  const { files, createdAt } = version;
  async function* entries(): AsyncGenerator<ZipEntry> {
    for (let i = 0; i < files.length; i += ZIP_BLOB_BATCH) {
      const batch = files.slice(i, i + ZIP_BLOB_BATCH);
      const bytes = await readBlobs([...new Set(batch.map((f) => f.sha256))]);
      for (const f of batch) {
        const b = bytes.get(f.sha256);
        if (!b) throw new Error(`blob ${f.sha256} of ${root}/${f.kind}/${f.path} is missing`);
        yield { name: `${root}/${f.kind}/${f.path}`, bytes: b, mtime: createdAt };
      }
    }
  }
  return { filename: `${root}.zip`, stream: zipStream(entries()) };
}
