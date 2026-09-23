import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, auditLog, blobs, users, versionFiles, workspaces } from '@drobek/db';
import {
  AppsError,
  createApp,
  createVersion,
  getVersion,
  latestVersionNumber,
  listVersions,
  publish,
  readVersionFile,
  restore,
  sweepUnreferencedBlobs,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  wsId = w.id;
  actor = { userId: u.id, kind: 'agent' };
});
afterAll(async () => close());

let n = 0;
async function newApp(): Promise<string> {
  n += 1;
  return (await createApp({ workspaceId: wsId, slug: `todo-${n}`, actor })).id;
}

const blobCount = async () => Number((await db.select({ c: sql<number>`count(*)` }).from(blobs))[0].c);

describe('createApp', () => {
  it('creates an app and audits app.create', async () => {
    const { id, slug } = await createApp({ workspaceId: wsId, slug: 'hello-world', actor });
    expect(slug).toBe('hello-world');
    const rows = await db.select().from(auditLog).where(eq(auditLog.target, 'hello-world'));
    expect(rows.map((r) => r.action)).toContain('app.create');
    expect(id).toBeTruthy();
  });

  it('rejects a taken slug with slug_taken + a free <slug>-<4hex> suggestion', async () => {
    await createApp({ workspaceId: wsId, slug: 'taken-name', actor });
    const err = await createApp({ workspaceId: wsId, slug: 'taken-name', actor }).catch((e) => e);
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('slug_taken');
    expect(err.suggestion).toMatch(/^taken-name-[0-9a-f]{4}$/);
    // The suggestion really is free.
    await expect(createApp({ workspaceId: wsId, slug: err.suggestion, actor })).resolves.toBeTruthy();
  });

  it('slugs are global: another workspace cannot reuse one', async () => {
    const [w2] = await db.insert(workspaces).values({ kind: 'team', slug: 'other', name: 'Other' }).returning();
    const err = await createApp({ workspaceId: w2.id, slug: 'hello-world', actor }).catch((e) => e);
    expect(err.code).toBe('slug_taken');
  });

  it.each(['ab', 'www', 'my--app', 'Upper', '-edge'])('rejects invalid slug %s', async (slug) => {
    const err = await createApp({ workspaceId: wsId, slug, actor }).catch((e) => e);
    expect(err.code).toBe('invalid_slug');
  });

  it('the database enforces the slug grammar too', async () => {
    await expect(db.insert(apps).values({ workspaceId: wsId, slug: 'bad--slug' })).rejects.toThrow();
  });
});

describe('versions', () => {
  let appId: string;
  beforeEach(async () => {
    appId = await newApp();
  });

  it('dedupes identical content: 2 versions with the same file = 1 blob', async () => {
    const before = await blobCount();
    const v1 = await createVersion(appId, [{ path: 'index.html', content: '<h1>same</h1>' }], { actor });
    const v2 = await createVersion(appId, [{ path: 'index.html', content: '<h1>same</h1>' }], { actor });
    expect([v1.number, v2.number]).toEqual([1, 2]);
    expect((await blobCount()) - before).toBe(1);
  });

  it('stores source and built files separately and reads them back', async () => {
    const v = await createVersion(
      appId,
      [
        { path: 'src/main.ts', content: 'export {}' },
        { path: 'main.js', content: Buffer.from('console.log(1)'), kind: 'built' },
      ],
      { actor, reasoning: 'first cut', compile: { status: 'ok' } }
    );
    const detail = await getVersion(appId, { number: v.number });
    expect(detail).toMatchObject({ number: 1, reasoning: 'first cut', compileStatus: 'ok', actorKind: 'agent' });
    expect(detail?.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['source:src/main.ts', 'built:main.js']);
    expect((await readVersionFile(v.id, 'main.js', 'built'))?.toString()).toBe('console.log(1)');
    expect(await readVersionFile(v.id, 'main.js', 'source')).toBeNull();
  });

  it('rejects unsafe or duplicate paths', async () => {
    await expect(createVersion(appId, [{ path: '../x.ts', content: '' }], { actor })).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      createVersion(appId, [{ path: 'a.ts', content: '1' }, { path: './a.ts', content: '2' }], { actor })
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('numbers versions without gaps under concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createVersion(appId, [{ path: 'index.html', content: `v${i}` }], { actor })
      )
    );
    const list = await listVersions(appId);
    expect(list.map((v) => v.number)).toEqual([5, 4, 3, 2, 1]);
    expect(await latestVersionNumber(appId)).toBe(5);
  });

  it('restore creates a NEW version with identical version_files', async () => {
    const v1 = await createVersion(
      appId,
      [
        { path: 'index.html', content: '<h1>v1</h1>' },
        { path: 'main.js', content: 'a()', kind: 'built' },
      ],
      { actor, compile: { status: 'ok' } }
    );
    await createVersion(appId, [{ path: 'index.html', content: '<h1>v2</h1>' }], { actor });
    const before = await blobCount();
    const v3 = await restore(appId, 1, { userId: actor.userId, kind: 'user' });
    expect(v3.number).toBe(3);
    const files = async (id: string) =>
      (await db.select().from(versionFiles).where(eq(versionFiles.versionId, id)))
        .map(({ versionId: _v, ...f }) => f)
        .sort((a, b) => a.path.localeCompare(b.path));
    expect(await files(v3.id)).toEqual(await files(v1.id));
    expect(await blobCount()).toBe(before);
    const detail = await getVersion(appId, { id: v3.id });
    expect(detail).toMatchObject({ compileStatus: 'ok', actorKind: 'user', reasoning: 'Restore of version 1' });
    await expect(restore(appId, 99, actor)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('publish is an atomic pointer move with the history in the audit log', async () => {
    const v1 = await createVersion(appId, [{ path: 'index.html', content: 'p1' }], {
      actor,
      compile: { status: 'ok' },
    });
    const v2 = await createVersion(appId, [{ path: 'index.html', content: 'p2' }], {
      actor,
      compile: { status: 'ok' },
    });
    expect(await publish(appId, v1.id, actor)).toMatchObject({ number: 1, previousNumber: null });
    expect(await publish(appId, v2.id, actor)).toMatchObject({ number: 2, previousNumber: 1 });
    // Rolling back = publishing the older version again.
    expect(await publish(appId, v1.id, { userId: actor.userId, kind: 'user' })).toMatchObject({
      number: 1,
      previousNumber: 2,
    });

    const [app] = await db.select().from(apps).where(eq(apps.id, appId));
    expect(app.publishedVersionId).toBe(v1.id);
    expect((await listVersions(appId)).find((v) => v.published)?.number).toBe(1);

    const history = await db
      .select({ action: auditLog.action, meta: auditLog.meta, actorKind: auditLog.actorKind })
      .from(auditLog)
      .where(eq(auditLog.target, app.slug))
      .orderBy(auditLog.createdAt, auditLog.id);
    expect(history.filter((h) => h.action === 'app.publish')).toEqual([
      { action: 'app.publish', meta: { version: 1, previousVersion: null }, actorKind: 'agent' },
      { action: 'app.publish', meta: { version: 2, previousVersion: 1 }, actorKind: 'agent' },
      { action: 'app.publish', meta: { version: 1, previousVersion: 2 }, actorKind: 'user' },
    ]);
  });

  it('refuses to publish a version that did not compile, or of another app', async () => {
    const bad = await createVersion(appId, [{ path: 'src/main.ts', content: 'x(' }], {
      actor,
      compile: { status: 'error', errors: [{ code: 'build_error', text: 'Unexpected end of file' }] },
    });
    await expect(publish(appId, bad.id, actor)).rejects.toMatchObject({ code: 'not_publishable' });
    const other = await newApp();
    await expect(publish(other, bad.id, actor)).rejects.toMatchObject({ code: 'not_found' });
    const [app] = await db.select().from(apps).where(eq(apps.id, appId));
    expect(app.publishedVersionId).toBeNull();
  });
});

describe('blob GC', () => {
  const age = (sha: string, days: number) =>
    db.execute(sql`UPDATE blobs SET created_at = now() - make_interval(days => ${days}) WHERE sha256 = ${sha}`);

  it('deletes an unreferenced blob older than 7 days, never a referenced one', async () => {
    const appId = await newApp();
    const v = await createVersion(appId, [{ path: 'kept.txt', content: 'referenced forever' }], { actor });
    const kept = (await getVersion(appId, { id: v.id }))!.files[0].sha256;
    await db.insert(blobs).values([
      { sha256: 'orphan-old', bytes: Buffer.from('old'), size: 3 },
      { sha256: 'orphan-new', bytes: Buffer.from('new'), size: 3 },
    ]);
    await age('orphan-old', 8);
    await age(kept, 30);

    const { deleted } = await sweepUnreferencedBlobs();
    expect(deleted).toBe(1);
    const left = new Set((await db.select({ sha: blobs.sha256 }).from(blobs)).map((r) => r.sha));
    expect(left.has('orphan-old')).toBe(false);
    expect(left.has('orphan-new')).toBe(true);
    expect(left.has(kept)).toBe(true);
  });

  it('a blob reused by a new version gets a fresh grace period', async () => {
    const appId = await newApp();
    await db.insert(blobs).values({ sha256: 'x', bytes: Buffer.from('x'), size: 1 });
    const v = await createVersion(appId, [{ path: 'a.txt', content: 'reused' }], { actor });
    const sha = (await getVersion(appId, { id: v.id }))!.files[0].sha256;
    await db.delete(versionFiles).where(eq(versionFiles.versionId, v.id));
    await age(sha, 30);
    await createVersion(appId, [{ path: 'b.txt', content: 'reused' }], { actor });
    await db.delete(versionFiles).where(eq(versionFiles.sha256, sha));
    await sweepUnreferencedBlobs();
    const [row] = await db.select({ sha: blobs.sha256 }).from(blobs).where(eq(blobs.sha256, sha));
    expect(row?.sha).toBe(sha);
  });
});
