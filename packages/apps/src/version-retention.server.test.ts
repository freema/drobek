/**
 * The history retention and the workspace's source quota on a real (PGlite)
 * database: the retention deletes versions past APP_VERSIONS_KEEP but never
 * the published one, a rollback set, the version the preview serves or one
 * from the last hour, audits it and leaves a workspace with unknown limits
 * alone; the blob GC then removes the freed bytes; a deleted version answers
 * not_found saying so. The quota counts the unique bytes of a workspace's
 * live apps and refuses a version whose new bytes do not fit, storing nothing.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersions, auditLog, blobs, users, versionFiles, workspaces } from '@drobek/db';
import {
  AppsError,
  DEFAULT_APP_VERSIONS_KEEP,
  DEFAULT_WORKSPACE_SOURCE_QUOTA,
  assertSourceQuota,
  createApp,
  createVersion,
  missingVersionMessage,
  pruneVersionHistory,
  publish,
  restore,
  softDeleteApp,
  sweepUnreferencedBlobs,
  versionRetention,
  versionStorageLimits,
  versionStorageLimitsOf,
  workspaceSourceBytes,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let ann: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'ann@example.test' }).returning();
  ann = { userId: a.id, kind: 'agent' };
});
afterAll(async () => close());

let n = 0;
async function newWorkspace(): Promise<string> {
  n += 1;
  return (await db.insert(workspaces).values({ kind: 'team', slug: `keep-${n}`, name: `Keep ${n}` }).returning())[0].id;
}

async function newApp(workspaceId: string): Promise<{ id: string; slug: string }> {
  n += 1;
  return createApp({ workspaceId, slug: `history-${n}`, actor: ann });
}

const unlimited = { perApp: 100_000, perUser: 100_000 };

function write(appId: string, content: string, opts: { ok?: boolean; sourceQuota?: number } = {}) {
  return createVersion(appId, [{ path: 'index.html', content }], {
    actor: ann,
    versionLimits: unlimited,
    compile: { status: opts.ok === false ? 'error' : 'ok' },
    ...(opts.sourceQuota !== undefined ? { sourceQuota: opts.sourceQuota } : {}),
  });
}

/** Move every version of the app more than an hour back, out of the hourly window. */
async function ageVersions(appId: string): Promise<void> {
  await db
    .update(appVersions)
    .set({ createdAt: sql`${appVersions.createdAt} - make_interval(mins => 90)` })
    .where(eq(appVersions.appId, appId));
}

async function numbers(appId: string): Promise<number[]> {
  const rows = await db.select({ n: appVersions.number }).from(appVersions).where(eq(appVersions.appId, appId)).orderBy(appVersions.number);
  return rows.map((r) => r.n);
}

const keepFor =
  (plans: Record<string, number | null>) =>
  async (workspaceId: string): Promise<Record<string, number> | null> => {
    const keep = plans[workspaceId];
    if (keep === null) return null;
    return keep === undefined ? {} : { APP_VERSIONS_KEEP: keep };
  };

describe('versionStorageLimits', () => {
  it('reads APP_VERSIONS_KEEP / WORKSPACE_SOURCE_QUOTA, else the production defaults; a plan wins over the env', () => {
    expect(DEFAULT_APP_VERSIONS_KEEP).toBe(200);
    expect(DEFAULT_WORKSPACE_SOURCE_QUOTA).toBe(1073741824);
    expect(versionStorageLimits({})).toEqual({ keep: 200, sourceQuota: 1073741824 });
    expect(versionStorageLimits({ APP_VERSIONS_KEEP: ' 50 ', WORKSPACE_SOURCE_QUOTA: '1048576' })).toEqual({ keep: 50, sourceQuota: 1048576 });
    for (const bad of ['0', '-3', '2.5', 'lots', '']) {
      expect(versionStorageLimits({ APP_VERSIONS_KEEP: bad, WORKSPACE_SOURCE_QUOTA: bad })).toEqual({ keep: 200, sourceQuota: 1073741824 });
    }
    expect(versionStorageLimitsOf({ APP_VERSIONS_KEEP: 20 }, { WORKSPACE_SOURCE_QUOTA: '999' })).toEqual({ keep: 20, sourceQuota: 999 });
  });
});

describe('the retention (APP_VERSIONS_KEEP)', () => {
  it('deletes versions past the newest N but keeps the published one and a rollback set; audits; the GC frees the bytes', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push((await write(app.id, `<p>version ${i}</p>`)).id);
    // v2 goes live, then v5: v5 is published and v2 keeps its asset set for a rollback.
    await publish(app.id, ids[1], ann, { screen: false });
    await publish(app.id, ids[4], ann, { screen: false });
    await ageVersions(app.id);
    const freed = await db.select({ sha256: versionFiles.sha256 }).from(versionFiles).where(inArray(versionFiles.versionId, [ids[0], ids[6]]));

    const out = await pruneVersionHistory({ limits: keepFor({ [ws]: 3 }) });
    expect(out).toMatchObject({ apps: 1, versions: 5, skipped: 0, failed: 0 });
    expect(await numbers(app.id)).toEqual([2, 5, 8, 9, 10]);
    // The file rows went with their versions.
    expect(await db.select().from(versionFiles).where(inArray(versionFiles.versionId, [ids[0], ids[2], ids[3], ids[5], ids[6]]))).toEqual([]);
    const [audit] = await db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws), eq(auditLog.action, 'app.versions.prune')));
    expect(audit).toEqual({ action: 'app.versions.prune', actor: null, meta: { appId: app.id, versions: 5, from: 1, to: 7, keep: 3 } });

    // A second run has nothing left to do.
    expect(await pruneVersionHistory({ limits: keepFor({ [ws]: 3 }) })).toMatchObject({ apps: 0, versions: 0 });

    // The blob GC then removes the bytes only the deleted versions used.
    await db.update(blobs).set({ createdAt: sql`now() - interval '8 days'` });
    await sweepUnreferencedBlobs();
    const left = await db.select({ sha256: blobs.sha256 }).from(blobs).where(inArray(blobs.sha256, freed.map((f) => f.sha256)));
    expect(left).toEqual([]);
  });

  it('keeps the newest version that compiled (the preview serves it) and every version from the last hour', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    await write(app.id, '<p>works</p>');
    for (let i = 2; i <= 6; i++) await write(app.id, `<p>broken ${i}`, { ok: false });
    // Not an hour old yet: nothing goes.
    expect(await pruneVersionHistory({ limits: keepFor({ [ws]: 2 }) })).toMatchObject({ versions: 0 });
    expect(await numbers(app.id)).toEqual([1, 2, 3, 4, 5, 6]);

    await ageVersions(app.id);
    await write(app.id, '<p>broken 7', { ok: false });
    expect(await pruneVersionHistory({ limits: keepFor({ [ws]: 2 }) })).toMatchObject({ apps: 1, versions: 4 });
    expect(await numbers(app.id)).toEqual([1, 6, 7]);
  });

  it("uses each workspace's own limit, the env without a limits callback, and leaves a workspace with unknown limits alone", async () => {
    const small = await newWorkspace();
    const unknown = await newWorkspace();
    const a = await newApp(small);
    const b = await newApp(unknown);
    for (let i = 1; i <= 4; i++) {
      await write(a.id, `<p>a ${i}</p>`);
      await write(b.id, `<p>b ${i}</p>`);
    }
    await ageVersions(a.id);
    await ageVersions(b.id);
    const out = await pruneVersionHistory({ limits: keepFor({ [small]: 2, [unknown]: null }) });
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    expect(await numbers(a.id)).toEqual([3, 4]);
    expect(await numbers(b.id)).toEqual([1, 2, 3, 4]);

    await pruneVersionHistory({ env: { APP_VERSIONS_KEEP: '3' } });
    expect(await numbers(b.id)).toEqual([2, 3, 4]);
  });

  it('prunes deleted apps too and survives a limits callback that throws', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    for (let i = 1; i <= 3; i++) await write(app.id, `<p>gone ${i}</p>`);
    await softDeleteApp(app.id, ann);
    await ageVersions(app.id);
    const logged: string[] = [];
    const out = await pruneVersionHistory({
      limits: async (id) => {
        if (id === ws) return { APP_VERSIONS_KEEP: 1 };
        throw new Error('provider down');
      },
      log: (msg) => logged.push(msg),
    });
    expect(await numbers(app.id)).toEqual([3]);
    expect(out.failed).toBe(0);
    if (out.skipped > 0) expect(logged).toContain('version retention: the limits of a workspace are unavailable');
  });

  it('a deleted version answers not_found saying the retention deleted it; versionRetention reports what is kept', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    for (let i = 1; i <= 5; i++) await write(app.id, `<p>r ${i}</p>`);
    await ageVersions(app.id);
    await pruneVersionHistory({ limits: keepFor({ [ws]: 2 }) });
    expect(await versionRetention(app.id, 2)).toEqual({ keep: 2, stored: 2, oldest: 4, newest: 5 });

    const err = (await restore(app.id, 1, ann, { versionLimits: unlimited }).catch((e: unknown) => e)) as AppsError;
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe(
      'Version 1 is no longer stored: the history retention deleted it. An app keeps its newest versions, the published one and those kept for a rollback; the oldest version still stored is 4.'
    );
    expect(await missingVersionMessage(app.id, 3, { keep: 2 })).toContain('An app keeps its newest 2 versions');
    expect(await missingVersionMessage(app.id, 9)).toBe('Version 9 does not exist — the newest version is 5.');
    const empty = await newApp(ws);
    expect(await missingVersionMessage(empty.id, 1)).toBe('Version 1 does not exist — the app has no versions yet.');
    await expect(restore(app.id, 4, ann, { versionLimits: unlimited })).resolves.toMatchObject({ number: 6 });
  });
});

describe('the source quota (WORKSPACE_SOURCE_QUOTA)', () => {
  it('counts the unique bytes of the live apps of one workspace', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const one = await newApp(ws);
    const two = await newApp(ws);
    await write(one.id, 'a'.repeat(100));
    await write(one.id, 'b'.repeat(50));
    // The same bytes in another app of the workspace count once; another workspace does not count.
    await write(two.id, 'a'.repeat(100));
    await write((await newApp(other)).id, 'c'.repeat(1000));
    expect(await workspaceSourceBytes(ws)).toBe(150);

    await softDeleteApp(one.id, ann);
    expect(await workspaceSourceBytes(ws)).toBe(100);
  });

  it('refuses a version whose new bytes do not fit with limit_exceeded naming the limit; nothing is stored', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    await write(app.id, 'x'.repeat(600), { sourceQuota: 1000 });
    const blobsBefore = await db.select({ c: sql<number>`count(*)` }).from(blobs);

    const err = (await write(app.id, 'y'.repeat(500), { sourceQuota: 1000 }).catch((e: unknown) => e)) as AppsError;
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('limit_exceeded');
    expect(err.details).toEqual({ limit: 'WORKSPACE_SOURCE_QUOTA', value: 1000, used_bytes: 600 });
    expect(err.message).toContain('WORKSPACE_SOURCE_QUOTA');
    expect(err.message).toContain('nothing was stored');
    expect(await numbers(app.id)).toEqual([1]);
    expect(await db.select({ c: sql<number>`count(*)` }).from(blobs)).toEqual(blobsBefore);

    // What fits is stored; bytes the workspace already has add nothing.
    await expect(write(app.id, 'y'.repeat(400), { sourceQuota: 1000 })).resolves.toMatchObject({ number: 2 });
    await expect(write(app.id, 'x'.repeat(600), { sourceQuota: 1000 })).resolves.toMatchObject({ number: 3 });
    await expect(assertSourceQuota(ws, [{ content: 'x'.repeat(600) }], 1000)).resolves.toBeUndefined();
    await expect(assertSourceQuota(ws, [{ content: 'z' }], 1000)).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('a restore adds no bytes and is never refused, even over a lowered quota', async () => {
    const ws = await newWorkspace();
    const app = await newApp(ws);
    await write(app.id, 'one'.repeat(100));
    await write(app.id, 'two'.repeat(100));
    // The operator lowered the quota below what is stored: writes of new bytes stop, restores go on.
    await expect(write(app.id, 'three', { sourceQuota: 100 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(restore(app.id, 1, ann, { versionLimits: unlimited })).resolves.toMatchObject({ number: 3 });
    // Deleting an app of the workspace frees its bytes at once.
    const big = await newApp(ws);
    await write(big.id, 'big'.repeat(1000), { sourceQuota: 10_000 });
    await expect(write(app.id, 'four'.repeat(100), { sourceQuota: 3_900 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    await softDeleteApp(big.id, ann);
    await expect(write(app.id, 'four'.repeat(100), { sourceQuota: 3_900 })).resolves.toMatchObject({ number: 4 });
  });

  it('without an explicit quota the env applies (default 1 GiB)', async () => {
    const app = await newApp(await newWorkspace());
    await expect(createVersion(app.id, [{ path: 'index.html', content: 'x' }], { actor: ann })).resolves.toMatchObject({ number: 1 });
  });
});
