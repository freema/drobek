import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  SLUG_RELEASE_AFTER_MS,
  createApp,
  createVersion,
  leaseKey,
  publish,
  readAppLease,
  releaseAppLease,
  releaseDeletedAppSlugs,
  setAppVisibility,
  setFrameAncestors,
  softDeleteApp,
  tombstoneSlug,
  unpublishApp,
  type Actor,
  type LeaseRedis,
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
  actor = { userId: u.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
async function newApp(prefix = 'life'): Promise<{ id: string; slug: string }> {
  n += 1;
  return createApp({ workspaceId: wsId, slug: `${prefix}-${n}`, actor });
}

async function auditOf(slug: string): Promise<{ action: string; meta: unknown; actorUserId: string | null }[]> {
  const rows = await db
    .select({ action: auditLog.action, meta: auditLog.meta, actorUserId: auditLog.actorUserId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug)))
    .orderBy(auditLog.createdAt);
  return rows;
}

async function appRow(id: string) {
  const [row] = await db.select().from(apps).where(eq(apps.id, id));
  return row;
}

const DAY = 24 * 60 * 60 * 1000;

describe('unpublishApp', () => {
  it('clears the published pointer and audits app.unpublish with the version that was live', async () => {
    const app = await newApp();
    const v = await createVersion(app.id, [{ path: 'index.html', content: 'x' }], { actor, compile: { status: 'ok' } });
    await publish(app.id, v.id, actor);
    const out = await unpublishApp(app.id, actor);
    expect(out.previousNumber).toBe(1);
    expect((await appRow(app.id)).publishedVersionId).toBeNull();
    const audit = await auditOf(app.slug);
    expect(audit.at(-1)).toMatchObject({ action: 'app.unpublish', meta: { previousVersion: 1 } });
  });

  it('refuses an app that is not published', async () => {
    const app = await newApp();
    const err = await unpublishApp(app.id, actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppsError);
    expect(err.code).toBe('not_published');
  });
});

describe('softDeleteApp + slug release', () => {
  it('marks the app deleted, audits app.delete, and refuses a second delete', async () => {
    const app = await newApp();
    const now = new Date('2026-09-01T10:00:00Z');
    const out = await softDeleteApp(app.id, actor, { now });
    expect(out.slugReleaseAt.getTime()).toBe(now.getTime() + SLUG_RELEASE_AFTER_MS);
    expect((await appRow(app.id)).deletedAt?.getTime()).toBe(now.getTime());
    const audit = await auditOf(app.slug);
    expect(audit.at(-1)).toMatchObject({
      action: 'app.delete',
      meta: { slugReleaseAt: '2026-10-01T10:00:00.000Z' },
    });
    const again = await softDeleteApp(app.id, actor).catch((e) => e);
    expect(again.code).toBe('not_found');
    // Every other mutation treats it as gone too.
    expect((await unpublishApp(app.id, actor).catch((e) => e)).code).toBe('not_found');
    expect((await setFrameAncestors(app.id, null, actor).catch((e) => e)).code).toBe('not_found');
  });

  it('keeps the slug for 30 days, then releases it (injected clock)', async () => {
    const app = await newApp('keep');
    const deletedAt = new Date('2026-08-01T00:00:00Z');
    await softDeleteApp(app.id, actor, { now: deletedAt });

    // Day 29: still held.
    let out = await releaseDeletedAppSlugs({ now: new Date(deletedAt.getTime() + 29 * DAY) });
    expect(out.released.map((r) => r.appId)).not.toContain(app.id);
    expect((await appRow(app.id)).slug).toBe(app.slug);

    // Day 30: released → the tombstone slug, audited as a system action.
    out = await releaseDeletedAppSlugs({ now: new Date(deletedAt.getTime() + 30 * DAY) });
    expect(out.released).toContainEqual({ appId: app.id, workspaceId: wsId, slug: app.slug });
    expect((await appRow(app.id)).slug).toBe(tombstoneSlug(app.slug, app.id));
    const audit = await auditOf(app.slug);
    expect(audit.at(-1)).toMatchObject({ action: 'app.slug_release', actorUserId: null, meta: { appId: app.id } });

    // Idempotent: a second sweep does not rename the tombstone again.
    out = await releaseDeletedAppSlugs({ now: new Date(deletedAt.getTime() + 60 * DAY) });
    expect(out.released.map((r) => r.appId)).not.toContain(app.id);

    // The slug is free: a new app takes it.
    const again = await createApp({ workspaceId: wsId, slug: app.slug, actor });
    expect(again.slug).toBe(app.slug);
    expect(again.id).not.toBe(app.id);
  });

  it('createApp: slug_taken inside the 30 days, released on demand after them', async () => {
    const recent = await newApp('recent');
    await softDeleteApp(recent.id, actor, { now: new Date(Date.now() - 29 * DAY) });
    const err = await createApp({ workspaceId: wsId, slug: recent.slug, actor }).catch((e) => e);
    expect(err.code).toBe('slug_taken');

    const old = await newApp('old');
    await softDeleteApp(old.id, actor, { now: new Date(Date.now() - 31 * DAY) });
    const created = await createApp({ workspaceId: wsId, slug: old.slug, actor });
    expect(created.slug).toBe(old.slug);
    expect((await appRow(old.id)).slug).toBe(tombstoneSlug(old.slug, old.id));
  });

  it('the database admits a tombstone only on a deleted row', async () => {
    const app = await newApp();
    await expect(
      db.update(apps).set({ slug: tombstoneSlug(app.slug, app.id) }).where(eq(apps.id, app.id))
    ).rejects.toThrow();
  });
});

describe('setAppVisibility', () => {
  it('password needs a hash first; public drops the hash; each change is audited', async () => {
    const app = await newApp();
    const err = await setAppVisibility(app.id, { visibility: 'password' }, actor).catch((e) => e);
    expect(err.code).toBe('invalid_settings');

    expect((await setAppVisibility(app.id, { visibility: 'password', passwordHash: 'scrypt$aa$bb' }, actor)).changed).toBe(true);
    let row = await appRow(app.id);
    expect(row.visibility).toBe('password');
    expect(row.passwordHash).toBe('scrypt$aa$bb');

    // Same state again → no-op, no audit row.
    expect((await setAppVisibility(app.id, { visibility: 'password' }, actor)).changed).toBe(false);
    // A new password while protected → changed.
    expect((await setAppVisibility(app.id, { visibility: 'password', passwordHash: 'scrypt$cc$dd' }, actor)).changed).toBe(true);

    expect((await setAppVisibility(app.id, { visibility: 'public' }, actor)).changed).toBe(true);
    row = await appRow(app.id);
    expect(row.visibility).toBe('public');
    expect(row.passwordHash).toBeNull();

    const audit = (await auditOf(app.slug)).filter((a) => a.action.startsWith('app.visibility.'));
    expect(audit.map((a) => [a.action, a.meta])).toEqual([
      ['app.visibility.password', { previous: 'public', passwordChanged: true }],
      ['app.visibility.password', { previous: 'password', passwordChanged: true }],
      ['app.visibility.public', { previous: 'password' }],
    ]);
    // Never the hash itself.
    expect(JSON.stringify(audit)).not.toContain('scrypt');
  });
});

describe('setFrameAncestors', () => {
  it('stores the override and audits old → new', async () => {
    const app = await newApp();
    expect((await setFrameAncestors(app.id, 'https://intranet.example.com', actor)).changed).toBe(true);
    expect((await setFrameAncestors(app.id, 'https://intranet.example.com', actor)).changed).toBe(false);
    expect((await setFrameAncestors(app.id, null, actor)).changed).toBe(true);
    expect((await appRow(app.id)).frameAncestors).toBeNull();
    const audit = (await auditOf(app.slug)).filter((a) => a.action === 'app.frame_ancestors.change');
    expect(audit.map((a) => a.meta)).toEqual([
      { previous: null, value: 'https://intranet.example.com' },
      { previous: 'https://intranet.example.com', value: null },
    ]);
  });
});

describe('releaseAppLease', () => {
  function fakeRedis(store: Map<string, string>): LeaseRedis {
    return {
      get: async (key: string) => store.get(key) ?? null,
      eval: async (_script: string, _n: number, key: string) => {
        const cur = store.get(key) ?? null;
        store.delete(key);
        return cur;
      },
    } as unknown as LeaseRedis;
  }

  it('removes the lease and audits app.lock.release with the previous holder', async () => {
    const app = await newApp();
    const store = new Map<string, string>();
    const redis = fakeRedis(store);
    const lease = {
      holder_user_id: 'user-agent-1',
      session_id: 's1',
      expires_at: '2026-09-23T10:03:00.000Z',
      renewed_at: '2026-09-23T10:00:00.000Z',
    };
    store.set(leaseKey(app.id), JSON.stringify(lease));
    expect(await readAppLease(app.id, redis)).toEqual(lease);

    const out = await releaseAppLease({ ...app, workspaceId: wsId }, actor, redis);
    expect(out).toEqual({ released: true, previous: lease });
    expect(store.has(leaseKey(app.id))).toBe(false);
    expect(await readAppLease(app.id, redis)).toBeNull();
    const audit = await auditOf(app.slug);
    expect(audit.at(-1)).toMatchObject({
      action: 'app.lock.release',
      actorUserId: actor.userId,
      meta: { previousHolderUserId: 'user-agent-1', expiresAt: lease.expires_at },
    });

    // Nothing to release → no audit row.
    const before = (await auditOf(app.slug)).length;
    expect(await releaseAppLease({ ...app, workspaceId: wsId }, actor, redis)).toEqual({ released: false, previous: null });
    expect((await auditOf(app.slug)).length).toBe(before);
  });
});
