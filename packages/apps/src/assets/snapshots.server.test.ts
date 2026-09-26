/**
 * NSO-362 — assets honour publish: the draft (preview) vs the set a publish
 * froze (production), rollback, restore, content addressing, the quota over
 * unique files, pruning, the sweep, the upload URL's editor re-check and the
 * upgrade migration.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appAssets, appVersionAssets, appVersions, memberships, setDbForTests, users, workspaces } from '@drobek/db';
import {
  ASSET_SNAPSHOTS_KEPT,
  AssetDisk,
  AssetsError,
  assetUsage,
  checkAssetUpload,
  createApp,
  createAssetUploadHandler,
  createUploadToken,
  createVersion,
  deleteAsset,
  findServedAsset,
  listAssets,
  listPublishedOnlyAssets,
  memoryUploadTokenStore,
  publish,
  restore,
  storeAsset,
  sweepAssets,
  unpublishApp,
  uploaderMayEdit,
  type Actor,
  type AssetApp,
  type AssetLimits,
} from '../index.js';
import { freshDb, migrateTo, migrationsUpTo, type TestDb } from '../test/db.js';
import { chunks, fakeMp4 } from '../test/assets.js';

let db: TestDb;
let pg: PGlite;
let wsId: string;
let userId: string;
let actor: Actor;
let root: string;
let disk: AssetDisk;
const LIMITS: AssetLimits = { maxBytes: 64 * 1024, quota: 100 * 1024 };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  pg = t.pg;
  const [u] = await db.insert(users).values({ email: 'snap@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'snap', name: 'Snap' }).returning();
  wsId = w.id;
  userId = u.id;
  actor = { userId: u.id, kind: 'agent' };
  await db.insert(memberships).values({ userId, workspaceId: wsId, role: 'editor' });
  root = mkdtempSync(join(tmpdir(), 'drobek-snap-'));
  disk = new AssetDisk(root);
});
afterAll(async () => {
  await pg.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function newApp(): Promise<AssetApp> {
  n += 1;
  const a = await createApp({ workspaceId: wsId, slug: `snap-${n}`, actor });
  return { id: a.id, slug: a.slug, workspaceId: wsId };
}

async function okVersion(app: AssetApp, content = `v${Math.random()}`): Promise<{ id: string; number: number }> {
  return createVersion(app.id, [{ path: 'index.html', content }], { actor, compile: { status: 'ok' } });
}

async function upload(app: AssetApp, name: string, bytes: Buffer, limits = LIMITS) {
  return storeAsset({ app, name, body: chunks(bytes), size: bytes.length, limits, actor, via: 'mcp', disk });
}

async function publishedId(appId: string): Promise<string> {
  const [row] = await db.select({ id: schema.apps.publishedVersionId }).from(schema.apps).where(eq(schema.apps.id, appId));
  return row!.id!;
}

/** What the production host serves at `name` (the live version's frozen set). */
async function prod(appId: string, name: string) {
  return findServedAsset(appId, name, { versionId: await publishedId(appId) });
}

const filesOf = (appId: string) => (existsSync(join(root, appId)) ? readdirSync(join(root, appId)).sort() : []);

async function refusal(p: Promise<unknown>): Promise<AssetsError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AssetsError) return err;
    throw err;
  }
  throw new Error('expected an AssetsError');
}

describe('the production host serves the set the last publish froze', () => {
  it('an upload or a delete changes only the draft (preview) until publish', async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    const film1 = fakeMp4(3000, 1);
    const first = await upload(app, 'film.mp4', film1);
    await publish(app.id, v1.id, actor, { screen: false });
    expect((await prod(app.id, 'film.mp4'))?.sha256).toBe(first.sha256);

    // Replace + a new asset: the preview shows both at once, production neither.
    const second = await upload(app, 'film.mp4', fakeMp4(3500, 2));
    await upload(app, 'extra.mp4', fakeMp4(1000, 3));
    expect((await findServedAsset(app.id, 'film.mp4'))?.sha256).toBe(second.sha256);
    expect((await prod(app.id, 'film.mp4'))?.sha256).toBe(first.sha256);
    expect(await prod(app.id, 'extra.mp4')).toBeNull();
    // The old bytes stay on disk: production still serves them.
    expect(filesOf(app.id)).toContain(first.sha256);

    // A delete: gone from the preview, production keeps serving it.
    expect(await deleteAsset({ app, name: 'film.mp4', actor, via: 'mcp', disk })).toBe(true);
    expect(await findServedAsset(app.id, 'film.mp4')).toBeNull();
    expect((await prod(app.id, 'film.mp4'))?.sha256).toBe(first.sha256);
    expect(filesOf(app.id)).toContain(first.sha256);
    expect(filesOf(app.id)).not.toContain(second.sha256); // referenced by nothing any more

    // list_assets / the Assets tab: per-asset published flag + the deletions waiting for a publish.
    expect((await listAssets(app.id)).map((a) => [a.name, a.published])).toEqual([['extra.mp4', false]]);
    expect((await listPublishedOnlyAssets(app.id)).map((a) => a.path)).toEqual(['/film.mp4']);

    // Publishing again (the same version — the one the preview shows) puts the draft live.
    const out = await publish(app.id, v1.id, actor, { screen: false });
    expect(out.assets).toBe('draft');
    expect(await prod(app.id, 'film.mp4')).toBeNull();
    expect(await prod(app.id, 'extra.mp4')).not.toBeNull();
    expect((await listAssets(app.id)).map((a) => [a.name, a.published])).toEqual([['extra.mp4', true]]);
    expect(await listPublishedOnlyAssets(app.id)).toEqual([]);
  });

  it('an unpublished app: the production scope finds nothing; a version host falls back to the draft', async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    await upload(app, 'a.mp4', fakeMp4(1200, 4));
    expect(await findServedAsset(app.id, 'a.mp4', { versionId: v1.id })).toBeNull();
    expect(await findServedAsset(app.id, 'a.mp4', { versionId: v1.id, orDraft: true })).not.toBeNull();
    await publish(app.id, v1.id, actor, { screen: false });
    await unpublishApp(app.id, actor);
    // The frozen set survives an unpublish (a later publish of v1 as a rollback brings it back).
    expect(await findServedAsset(app.id, 'a.mp4', { versionId: v1.id })).not.toBeNull();
  });

  it('publishing an older version (the rollback) brings back the assets it served; a never-published one takes the draft', async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    const old = await upload(app, 'logo.mp4', fakeMp4(2000, 5));
    await publish(app.id, v1.id, actor, { screen: false });
    const v2 = await okVersion(app);
    const fresh = await upload(app, 'logo.mp4', fakeMp4(2100, 6));
    await publish(app.id, v2.id, actor, { screen: false });
    expect((await prod(app.id, 'logo.mp4'))?.sha256).toBe(fresh.sha256);

    const back = await publish(app.id, v1.id, actor, { screen: false });
    expect(back.assets).toBe('kept');
    expect((await prod(app.id, 'logo.mp4'))?.sha256).toBe(old.sha256);
    // The draft is untouched by a rollback.
    expect((await findServedAsset(app.id, 'logo.mp4'))?.sha256).toBe(fresh.sha256);

    const v3 = await okVersion(app); // never published, and not the preview's version after v4
    await okVersion(app);
    const out = await publish(app.id, v3.id, actor, { screen: false });
    expect(out.assets).toBe('draft');
    expect((await prod(app.id, 'logo.mp4'))?.sha256).toBe(fresh.sha256);
  });
});

describe('restore_version brings back the assets of a published version', () => {
  it('resets the draft to the set the version served; publishing the restore puts it live', async () => {
    const app = await newApp();
    const v1 = await okVersion(app, 'one');
    const a1 = await upload(app, 'film.mp4', fakeMp4(3000, 7));
    await upload(app, 'poster.mp4', fakeMp4(1000, 8));
    await publish(app.id, v1.id, actor, { screen: false });
    const v2 = await okVersion(app, 'two');
    const a2 = await upload(app, 'film.mp4', fakeMp4(3100, 9));
    await deleteAsset({ app, name: 'poster.mp4', actor, via: 'mcp', disk });
    await upload(app, 'new.mp4', fakeMp4(900, 10));
    await publish(app.id, v2.id, actor, { screen: false });

    const r = await restore(app.id, v1.number, actor);
    expect(r.assetsRestored).toBe(true);
    const draft = await listAssets(app.id);
    expect(draft.map((a) => [a.name, a.sha256])).toEqual([
      ['film.mp4', a1.sha256],
      ['poster.mp4', expect.any(String)],
    ]);
    // Production is unchanged until the restore is published …
    expect((await prod(app.id, 'film.mp4'))?.sha256).toBe(a2.sha256);
    // … then it serves v1's files AND v1's assets again.
    const out = await publish(app.id, r.id, actor, { screen: false });
    expect(out.assets).toBe('draft');
    expect((await prod(app.id, 'film.mp4'))?.sha256).toBe(a1.sha256);
    expect(await prod(app.id, 'poster.mp4')).not.toBeNull();
    expect(await prod(app.id, 'new.mp4')).toBeNull();
    for (const a of await listAssets(app.id)) expect(existsSync(disk.pathOf(app.id, (await findServedAsset(app.id, a.name))!.storageKey))).toBe(true);
  });

  it('a version that was never published leaves the draft assets alone (assetsRestored: false)', async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    await okVersion(app);
    await upload(app, 'keep.mp4', fakeMp4(1000, 11));
    const r = await restore(app.id, v1.number, actor);
    expect(r.assetsRestored).toBe(false);
    expect((await listAssets(app.id)).map((a) => a.name)).toEqual(['keep.mp4']);
  });
});

describe('content-addressed files, the quota over unique files, pruning', () => {
  it('stores bytes under their sha256 once per app, whatever the number of names or sets', async () => {
    const app = await newApp();
    const bytes = fakeMp4(2000, 12);
    const a = await upload(app, 'a.mp4', bytes);
    const b = await upload(app, 'b/a.mp4', bytes);
    expect(a.sha256).toBe(b.sha256);
    expect(filesOf(app.id)).toEqual([a.sha256]);
    expect((await findServedAsset(app.id, 'b/a.mp4'))?.storageKey).toBe(a.sha256);
    expect(await assetUsage(app.id)).toBe(2000);
    // Deleting one name keeps the shared file.
    await deleteAsset({ app, name: 'a.mp4', actor, via: 'mcp', disk });
    expect(filesOf(app.id)).toEqual([a.sha256]);
  });

  it('a replaced published asset counts until the next publish; then the old set is pruned when space is needed', async () => {
    const app = await newApp();
    const limits: AssetLimits = { maxBytes: 64 * 1024, quota: 10_000 };
    const v1 = await okVersion(app);
    await upload(app, 'big.mp4', fakeMp4(6000, 13), limits);
    await publish(app.id, v1.id, actor, { screen: false });
    // Replacing it: draft 5000 + the published 6000 > 10000 → refused (up front and against the bytes).
    const e = await refusal(checkAssetUpload({ appId: app.id, name: 'big.mp4', size: 5000, limits }));
    expect(e.code).toBe('asset_quota_exceeded');
    expect(e.details).toMatchObject({ used_bytes: 6000 });
    expect((await refusal(upload(app, 'big.mp4', fakeMp4(5000, 14), limits))).code).toBe('asset_quota_exceeded');
    // A smaller replacement fits (3000 + 6000).
    const small = await upload(app, 'big.mp4', fakeMp4(3000, 15), limits);
    expect(await assetUsage(app.id)).toBe(9000);
    // After the publish only the draft/live set counts; v1's old set is history, kept while it fits …
    const v2 = await okVersion(app);
    await publish(app.id, v2.id, actor, { screen: false });
    expect(await assetUsage(app.id)).toBe(3000);
    const [v1Row] = await db.select({ frozenAt: appVersions.assetsFrozenAt }).from(appVersions).where(eq(appVersions.id, v1.id));
    expect(v1Row.frozenAt).not.toBeNull();
    // … and dropped (oldest first) when an upload needs the space: 3000 + 6000 (history) + 4000 > 10000.
    await upload(app, 'more.mp4', fakeMp4(4000, 16), limits);
    const [pruned] = await db.select({ frozenAt: appVersions.assetsFrozenAt }).from(appVersions).where(eq(appVersions.id, v1.id));
    expect(pruned.frozenAt).toBeNull();
    expect(await db.select().from(appVersionAssets).where(eq(appVersionAssets.versionId, v1.id))).toEqual([]);
    // A rollback to a pruned version publishes the draft instead.
    expect((await publish(app.id, v1.id, actor, { screen: false })).assets).toBe('draft');
    expect((await prod(app.id, 'big.mp4'))?.sha256).toBe(small.sha256);
  });

  it(`keeps the sets of at most ${ASSET_SNAPSHOTS_KEPT} earlier publishes besides the live one`, async () => {
    const app = await newApp();
    await upload(app, 'x.mp4', fakeMp4(1000, 17));
    const ids: string[] = [];
    for (let i = 0; i < ASSET_SNAPSHOTS_KEPT + 3; i++) {
      const v = await okVersion(app);
      ids.push(v.id);
      await publish(app.id, v.id, actor, { screen: false });
    }
    const frozen = await db
      .select({ id: appVersions.id })
      .from(appVersions)
      .where(and(eq(appVersions.appId, app.id), sql`${appVersions.assetsFrozenAt} IS NOT NULL`));
    expect(frozen).toHaveLength(ASSET_SNAPSHOTS_KEPT + 1);
    expect(frozen.map((f) => f.id)).not.toContain(ids[0]);
    expect(frozen.map((f) => f.id)).toContain(ids.at(-1));
  });
});

describe('sweepAssets keeps what a published set references', () => {
  it('removes old files no draft row or kept set references; never one production serves', async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    const live = await upload(app, 'live.mp4', fakeMp4(1000, 18));
    await publish(app.id, v1.id, actor, { screen: false });
    await deleteAsset({ app, name: 'live.mp4', actor, via: 'mcp', disk }); // draft-only delete
    // A leftover file (an upload that failed after its move), and a published file, both old.
    const leftover = 'e'.repeat(64);
    writeFileSync(join(root, app.id, leftover), 'x');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(root, app.id, leftover), old, old);
    utimesSync(join(root, app.id, live.sha256), old, old);
    const out = await sweepAssets({ disk });
    expect(out.orphans).toBeGreaterThanOrEqual(1);
    expect(filesOf(app.id)).toEqual([live.sha256]);
    expect(await prod(app.id, 'live.mp4')).not.toBeNull();
  });

  it("a deleted app's frozen sets go with its draft", async () => {
    const app = await newApp();
    const v1 = await okVersion(app);
    await upload(app, 'g.mp4', fakeMp4(1000, 19));
    await publish(app.id, v1.id, actor, { screen: false });
    await db.update(schema.apps).set({ deletedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(schema.apps.id, app.id));
    await sweepAssets({ disk });
    expect(await db.select().from(appAssets).where(eq(appAssets.appId, app.id))).toEqual([]);
    expect(await db.select().from(appVersionAssets).where(eq(appVersionAssets.appId, app.id))).toEqual([]);
    expect(existsSync(join(root, app.id))).toBe(false);
  });
});

describe('the upload URL re-checks the uploader at PUT time', () => {
  let server: Server;
  let base: string;
  const store = memoryUploadTokenStore();

  beforeAll(async () => {
    server = createServer(createAssetUploadHandler({ limits: async () => LIMITS, hint: (c) => `hint:${c}`, tokens: store, disk }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/upload/`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function memberUser(email: string, role: 'editor' | 'viewer' | 'workspace-admin') {
    const [u] = await db.insert(users).values({ email }).returning();
    await db.insert(memberships).values({ userId: u.id, workspaceId: wsId, role });
    return u.id;
  }

  async function mint(app: AssetApp, uid: string): Promise<string> {
    const { token } = await createUploadToken(store, {
      appId: app.id,
      appSlug: app.slug,
      workspaceId: app.workspaceId,
      name: 'film.mp4',
      size: 2048,
      contentType: '',
      userId: uid,
      actorKind: 'user',
      via: 'dashboard',
    });
    return token;
  }

  it('a member removed after the link was issued cannot complete the upload (403, nothing stored, link burnt)', async () => {
    const app = await newApp();
    const uid = await memberUser('gone@example.test', 'editor');
    const token = await mint(app, uid);
    await db.delete(memberships).where(and(eq(memberships.userId, uid), eq(memberships.workspaceId, wsId)));
    const r = await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(2048)) });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: 'forbidden', hint: 'hint:forbidden' });
    expect(await findServedAsset(app.id, 'film.mp4')).toBeNull();
    expect((await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(2048)) })).status).toBe(404);
  });

  it('a member demoted to viewer cannot either; a current editor can', async () => {
    const app = await newApp();
    const uid = await memberUser('demoted@example.test', 'editor');
    const token = await mint(app, uid);
    await db.update(memberships).set({ role: 'viewer' }).where(eq(memberships.userId, uid));
    expect((await fetch(`${base}${token}`, { method: 'PUT', body: new Uint8Array(fakeMp4(2048)) })).status).toBe(403);
    const ok = await fetch(`${base}${await mint(app, userId)}`, { method: 'PUT', body: new Uint8Array(fakeMp4(2048)) });
    expect(ok.status).toBe(201);
  });

  it('uploaderMayEdit: editor+ of the workspace, or a super-admin by SUPERADMIN_EMAIL', async () => {
    const admin = await memberUser('boss@example.test', 'workspace-admin');
    const viewer = await memberUser('look@example.test', 'viewer');
    const [outsider] = await db.insert(users).values({ email: 'Root@Example.test' }).returning();
    expect(await uploaderMayEdit(admin, wsId, {})).toBe(true);
    expect(await uploaderMayEdit(userId, wsId, {})).toBe(true);
    expect(await uploaderMayEdit(viewer, wsId, {})).toBe(false);
    expect(await uploaderMayEdit(outsider.id, wsId, {})).toBe(false);
    expect(await uploaderMayEdit(outsider.id, wsId, { SUPERADMIN_EMAIL: 'x@y.z, root@example.test' })).toBe(true);
  });
});

describe('migration 0025 (asset snapshots) on a database with NSO-358 assets', () => {
  it('freezes the assets of every published app as its live set; they stay the draft too', async () => {
    const mpg = new PGlite();
    const mdb = drizzle(mpg, { schema });
    try {
      await migrateTo(mdb, migrationsUpTo(24));
      await mpg.exec(`
        INSERT INTO users (id, email) VALUES ('mu', 'm@example.test');
        INSERT INTO workspaces (id, kind, slug, name) VALUES ('mw', 'personal', 'mig', 'Mig');
        INSERT INTO apps (id, workspace_id, slug) VALUES ('pub', 'mw', 'pub-app'), ('draft', 'mw', 'draft-app');
        INSERT INTO app_versions (id, app_id, number, actor_kind, compile_status) VALUES
          ('pub-1', 'pub', 1, 'agent', 'ok'), ('pub-2', 'pub', 2, 'agent', 'ok'), ('draft-1', 'draft', 1, 'agent', 'ok');
        UPDATE apps SET published_version_id = 'pub-1' WHERE id = 'pub';
        INSERT INTO app_assets (app_id, name, content_type, size, sha256, storage_key) VALUES
          ('pub', 'film.mp4', 'video/mp4', 10, 'aa', '0123456789abcdef0123456789abcdef'),
          ('pub', 'img/a.png', 'image/png', 5, 'bb', 'fedcba9876543210fedcba9876543210'),
          ('draft', 'x.mp4', 'video/mp4', 7, 'cc', '00000000000000000000000000000000');
      `);
      await migrateTo(mdb);
      const frozen = (
        await mdb.execute<{ version_id: string; name: string; storage_key: string }>(
          sql`SELECT version_id, name, storage_key FROM app_version_assets ORDER BY name`
        )
      ).rows;
      expect(frozen).toEqual([
        { version_id: 'pub-1', name: 'film.mp4', storage_key: '0123456789abcdef0123456789abcdef' },
        { version_id: 'pub-1', name: 'img/a.png', storage_key: 'fedcba9876543210fedcba9876543210' },
      ]);
      const marks = (
        await mdb.execute<{ id: string; frozen: boolean }>(sql`SELECT id, assets_frozen_at IS NOT NULL AS frozen FROM app_versions ORDER BY id`)
      ).rows;
      expect(marks).toEqual([
        { id: 'draft-1', frozen: false },
        { id: 'pub-1', frozen: true },
        { id: 'pub-2', frozen: false },
      ]);
      expect((await mdb.execute(sql`SELECT 1 FROM app_assets`)).rows).toHaveLength(3);

      // Served through the real lookups: production = the frozen set, preview = the draft.
      setDbForTests(mdb);
      expect(await findServedAsset('pub', 'film.mp4', { versionId: 'pub-1' })).toMatchObject({ storageKey: '0123456789abcdef0123456789abcdef' });
      expect(await findServedAsset('draft', 'x.mp4', { versionId: 'draft-1' })).toBeNull();
      expect(await findServedAsset('draft', 'x.mp4')).not.toBeNull();
    } finally {
      setDbForTests(db);
      await mpg.close();
    }
  });
});
