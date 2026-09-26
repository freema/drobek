/**
 * NSO-340 — the public gallery on a real (PGlite) database: listing needs a
 * published app and a valid description; the public list filters at query
 * time (unpublished, password-gated, taken down, deleted, hidden → gone) and
 * carries no owner data; unpublish / takedown clear the flag; the cursor
 * pages newest-first without gaps; the super-admin hide blocks listing.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  createApp,
  createVersion,
  listGallery,
  listGalleryForModeration,
  publish,
  restoreApp,
  setAppVisibility,
  setGalleryHidden,
  setGalleryListing,
  softDeleteApp,
  takedownApp,
  unpublishApp,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

const ON = { GALLERY_ENABLED: 'true', APPS_DOMAIN: 'apps.example.test', APPS_URL_SCHEME: 'https' } as NodeJS.ProcessEnv;

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: Actor;
let rootId: string;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [r] = await db.insert(users).values({ email: 'root@example.test' }).returning();
  rootId = r.id;
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  wsId = w.id;
  actor = { userId: u.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
async function publishedApp(name = 'Gallery app'): Promise<{ id: string; slug: string }> {
  n += 1;
  const app = await createApp({ workspaceId: wsId, slug: `gal-${n}`, name, actor });
  const v = await createVersion(app.id, [{ path: 'index.html', content: 'x' }], { actor, compile: { status: 'ok' } });
  await publish(app.id, v.id, actor, { screen: false });
  return app;
}

async function listed(desc = 'A small app that does one thing well.'): Promise<{ id: string; slug: string }> {
  const app = await publishedApp();
  await setGalleryListing(app.id, { listed: true, description: desc }, actor, { env: ON });
  return app;
}

async function slugsInGallery(): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await listGallery({ limit: 48, cursor, env: ON });
    out.push(...page.items.map((i) => new URL(i.url).hostname.split('.')[0]));
    cursor = page.next;
  } while (cursor);
  return out;
}

async function auditOf(slug: string) {
  return db
    .select({ action: auditLog.action, meta: auditLog.meta, actorKind: auditLog.actorKind })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, slug)))
    .orderBy(auditLog.createdAt);
}

async function row(id: string) {
  const [r] = await db.select().from(apps).where(eq(apps.id, id));
  return r;
}

describe('setGalleryListing', () => {
  it('lists a published app with a normalized description and audits app.gallery_listed', async () => {
    const app = await publishedApp();
    const out = await setGalleryListing(app.id, { listed: true, description: '  Plan\nshifts   for a small team. ' }, actor, { env: ON });
    expect(out).toMatchObject({ changed: true, listed: true, description: 'Plan shifts for a small team.' });
    expect(await row(app.id)).toMatchObject({ galleryListed: true, galleryDescription: 'Plan shifts for a small team.' });
    expect((await auditOf(app.slug)).at(-1)).toMatchObject({
      action: 'app.gallery_listed',
      meta: { description: 'Plan shifts for a small team.' },
    });
    // Same description again: no change, no second audit row.
    const again = await setGalleryListing(app.id, { listed: true, description: 'Plan shifts for a small team.' }, actor, { env: ON });
    expect(again.changed).toBe(false);
    expect((await auditOf(app.slug)).filter((a) => a.action === 'app.gallery_listed')).toHaveLength(1);
  });

  it('refuses an unpublished app, an empty or too long description, and a disabled gallery', async () => {
    const app = await createApp({ workspaceId: wsId, slug: 'gal-unpub', actor });
    const unpub = await setGalleryListing(app.id, { listed: true, description: 'Nice.' }, actor, { env: ON }).catch((e) => e);
    expect(unpub).toBeInstanceOf(AppsError);
    expect(unpub.code).toBe('not_published');

    const pub = await publishedApp();
    for (const description of ['', '   \n\t ', 'x'.repeat(161)]) {
      const err = await setGalleryListing(pub.id, { listed: true, description }, actor, { env: ON }).catch((e) => e);
      expect(err.code, JSON.stringify(description)).toBe('invalid_settings');
    }
    expect((await setGalleryListing(pub.id, { listed: true, description: 'x'.repeat(160) }, actor, { env: ON })).listed).toBe(true);

    const off = await setGalleryListing(pub.id, { listed: false }, actor, { env: {} }).catch((e) => e);
    expect(off.code).toBe('gallery_disabled');
  });

  it('unlists (audited, reason owner); unlisting again is a no-op; the description is kept', async () => {
    const app = await listed('Keep me.');
    const out = await setGalleryListing(app.id, { listed: false }, actor, { env: ON });
    expect(out).toMatchObject({ changed: true, listed: false, description: 'Keep me.' });
    expect((await auditOf(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_unlisted', meta: { reason: 'owner' } });
    expect((await setGalleryListing(app.id, { listed: false }, actor, { env: ON })).changed).toBe(false);
    expect((await row(app.id)).galleryDescription).toBe('Keep me.');
  });
});

describe('listGallery (the public list)', () => {
  it('shows listed apps with name, description, production URL and publish time — nothing else', async () => {
    const app = await listed('Counts things.');
    const { items } = await listGallery({ limit: 48, env: ON });
    const item = items.find((i) => i.url === `https://${app.slug}.apps.example.test`);
    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(['description', 'name', 'publishedAt', 'url']);
    expect(item).toMatchObject({ name: 'Gallery app', description: 'Counts things.' });
    expect(new Date(item!.publishedAt).toISOString()).toBe(item!.publishedAt);
    // No owner data anywhere in the payload.
    const json = JSON.stringify(items);
    expect(json).not.toContain('owner@example.test');
    expect(json).not.toContain(wsId);
    expect(json).not.toContain(app.id);
  });

  it('unpublish takes the app off at once and clears the flag (audited, reason unpublish)', async () => {
    const app = await listed();
    expect(await slugsInGallery()).toContain(app.slug);
    await unpublishApp(app.id, actor);
    expect(await slugsInGallery()).not.toContain(app.slug);
    expect(await row(app.id)).toMatchObject({ galleryListed: false, publishedAt: null });
    expect((await auditOf(app.slug)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['app.unpublish', 'app.gallery_unlisted'])
    );
    // Publishing again does not list it again by itself.
    const [v] = await db.select({ id: apps.publishedVersionId }).from(apps).where(eq(apps.id, app.id));
    expect(v.id).toBeNull();
  });

  it('a takedown takes it off and clears the flag; a restore does not bring it back', async () => {
    const app = await listed();
    await takedownApp({ appId: app.id, reason: 'spam', actorUserId: rootId });
    expect(await slugsInGallery()).not.toContain(app.slug);
    expect((await row(app.id)).galleryListed).toBe(false);
    expect((await auditOf(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_unlisted', meta: { reason: 'takedown' } });
    await restoreApp({ appId: app.id, actorUserId: rootId });
    expect(await slugsInGallery()).not.toContain(app.slug);
  });

  it('filters at query time even when the flag is still set: locked, deleted, password-gated, unpublished', async () => {
    const locked = await listed();
    const deleted = await listed();
    const gated = await listed();
    const unpub = await listed();
    // Flip state behind the flag's back (a direct write, as a crash between steps could leave it).
    await db.update(apps).set({ lockedReason: 'spam' }).where(eq(apps.id, locked.id));
    await softDeleteApp(deleted.id, actor);
    await setAppVisibility(gated.id, { visibility: 'password', passwordHash: 'x' }, actor);
    await db.update(apps).set({ publishedVersionId: null }).where(eq(apps.id, unpub.id));
    const slugs = await slugsInGallery();
    for (const a of [locked, deleted, gated, unpub]) {
      expect((await row(a.id)).galleryListed, a.slug).toBe(true);
      expect(slugs, a.slug).not.toContain(a.slug);
    }
  });

  it('pages newest publish first with a cursor, no gaps and no repeats (ties broken by slug)', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await listed()).slug);
    // Two entries with the SAME publish time: the slug orders them.
    const tie = new Date('2026-09-20T10:00:00.123Z');
    await db.update(apps).set({ publishedAt: tie }).where(eq(apps.slug, made[1]));
    await db.update(apps).set({ publishedAt: tie }).where(eq(apps.slug, made[2]));
    const all = await listGallery({ limit: 48, env: ON });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listGallery({ limit: 2, cursor, env: ON });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.url));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(all.items.map((i) => i.url));
    const times = all.items.map((i) => Date.parse(i.publishedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // A garbage cursor is the first page.
    expect((await listGallery({ limit: 2, cursor: '!!nope', env: ON })).items).toEqual(all.items.slice(0, 2));
  });
});

describe('setGalleryHidden (super-admin)', () => {
  it('hides a listed entry, blocks listing while hidden, shows it again — audited', async () => {
    const app = await listed();
    expect((await setGalleryHidden(app.id, true, rootId)).changed).toBe(true);
    expect(await slugsInGallery()).not.toContain(app.slug);
    expect((await auditOf(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_hidden' });
    const err = await setGalleryListing(app.id, { listed: true, description: 'Again.' }, actor, { env: ON }).catch((e) => e);
    expect(err.code).toBe('gallery_hidden');
    // Unlisting still works while hidden.
    expect((await setGalleryListing(app.id, { listed: false }, actor, { env: ON })).changed).toBe(true);
    const moderation = await listGalleryForModeration();
    expect(moderation.find((m) => m.id === app.id)).toMatchObject({ visible: false });
    expect((await setGalleryHidden(app.id, true, rootId)).changed).toBe(false);
    expect((await setGalleryHidden(app.id, false, rootId)).changed).toBe(true);
    expect((await auditOf(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_unhidden' });
    await setGalleryListing(app.id, { listed: true, description: 'Again.' }, actor, { env: ON });
    expect(await slugsInGallery()).toContain(app.slug);
    expect((await listGalleryForModeration()).find((m) => m.id === app.id)).toMatchObject({ visible: true, workspaceSlug: 'owner' });
  });
});

describe('publish sets published_at', () => {
  it('every publish moves published_at forward (ms precision)', async () => {
    const app = await publishedApp();
    const first = (await row(app.id)).publishedAt!;
    expect(first.getTime() % 1).toBe(0);
    const v2 = await createVersion(app.id, [{ path: 'index.html', content: 'y' }], { actor, compile: { status: 'ok' } });
    await new Promise((r) => setTimeout(r, 5));
    await publish(app.id, v2.id, actor, { screen: false });
    expect((await row(app.id)).publishedAt!.getTime()).toBeGreaterThan(first.getTime());
  });
});
