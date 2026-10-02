/**
 * Duplicating a gallery app on a real (PGlite) database: only a
 * visible gallery entry whose owner allows it; the copy is the PUBLISHED
 * version's files as version 1 of a new unpublished app that remembers its
 * source; audits on both sides; the per-person hourly cap; the public list's
 * `duplicable` / `duplicateUrl` / `duplicates`.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  copyName,
  createApp,
  createVersion,
  defaultCopyName,
  duplicateAppFiles,
  duplicatesPerUserHour,
  duplicationSource,
  getVersion,
  listGallery,
  publish,
  readVersionFile,
  setGalleryListing,
  softDeleteApp,
  type Actor,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

const ON = {
  GALLERY_ENABLED: 'true',
  APPS_DOMAIN: 'apps.example.test',
  APPS_URL_SCHEME: 'https',
  PUBLIC_APP_URL: 'https://dash.example.test',
} as NodeJS.ProcessEnv;

let db: TestDb;
let close: () => Promise<void>;
let authorWs: string;
let copierWs: string;
let author: Actor;
let copier: Actor;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'author@example.test' }).returning();
  const [c] = await db.insert(users).values({ email: 'copier@example.test' }).returning();
  const [w1] = await db.insert(workspaces).values({ kind: 'personal', slug: 'author', name: 'Author Studio' }).returning();
  const [w2] = await db.insert(workspaces).values({ kind: 'personal', slug: 'copier', name: 'Copier' }).returning();
  authorWs = w1.id;
  copierWs = w2.id;
  author = { userId: a.id, kind: 'user' };
  copier = { userId: c.id, kind: 'user' };
});
afterAll(async () => close());

let n = 0;
/** A published app whose preview (v2) differs from the published v1, listed in the gallery. */
async function galleryApp(opts: { allowDuplicate?: boolean } = {}) {
  n += 1;
  const app = await createApp({ workspaceId: authorWs, slug: `src-${n}`, name: `Pixel Wall ${n}`, actor: author });
  const v1 = await createVersion(
    app.id,
    [
      { path: 'index.html', content: '<h1>published</h1>' },
      { path: 'main.js', content: 'console.log(1)', kind: 'built' },
    ],
    { actor: author, compile: { status: 'ok' } }
  );
  await publish(app.id, v1.id, author, { screen: false });
  await createVersion(app.id, [{ path: 'index.html', content: '<h1>draft</h1>' }], { actor: author, compile: { status: 'ok' } });
  await setGalleryListing(app.id, { listed: true, description: 'Paint pixels.', allowDuplicate: opts.allowDuplicate ?? true }, author, { env: ON });
  return app;
}

async function auditIn(workspaceId: string, slug: string) {
  return db
    .select({ action: auditLog.action, meta: auditLog.meta, actorUserId: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.target, slug)));
}

describe('duplicationSource', () => {
  it('answers a duplicable gallery app with its public facts', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    expect(src).toMatchObject({ id: app.id, slug: app.slug, name: `Pixel Wall ${n}`, description: 'Paint pixels.', workspaceName: 'Author Studio', modules: [] });
  });

  it('refuses: gallery off, not listed / unknown (same answer), owner does not allow it', async () => {
    const app = await galleryApp({ allowDuplicate: false });
    expect(await duplicationSource(app.slug, {}).catch((e: AppsError) => e.code)).toBe('gallery_disabled');
    expect(await duplicationSource(app.slug, ON).catch((e: AppsError) => e.code)).toBe('not_duplicable');
    expect(await duplicationSource('no-such-app', ON).catch((e: AppsError) => e.code)).toBe('not_found');
    await setGalleryListing(app.id, { listed: false }, author, { env: ON });
    expect(await duplicationSource(app.slug, ON).catch((e: AppsError) => e.code)).toBe('not_found');
  });

  it('the owner turns duplicates on and off with the listing; unlisting keeps the choice', async () => {
    const app = await galleryApp({ allowDuplicate: false });
    const on = await setGalleryListing(app.id, { listed: true, description: 'Paint pixels.', allowDuplicate: true }, author, { env: ON });
    expect(on).toMatchObject({ changed: true, allowDuplicate: true });
    const kept = await setGalleryListing(app.id, { listed: true, description: 'Paint pixels.' }, author, { env: ON });
    expect(kept).toMatchObject({ changed: false, allowDuplicate: true });
    expect((await setGalleryListing(app.id, { listed: false }, author, { env: ON })).allowDuplicate).toBe(true);
  });
});

describe('copy names', () => {
  it('defaults to "<name> copy"; trims; refuses more than 80 characters', () => {
    expect(defaultCopyName('Pixel Wall')).toBe('Pixel Wall copy');
    expect([...defaultCopyName('x'.repeat(200))]).toHaveLength(80);
    expect(copyName('  My   wall ', { name: 'Pixel Wall' })).toBe('My wall');
    expect(copyName('', { name: 'Pixel Wall' })).toBe('Pixel Wall copy');
    expect(() => copyName('x'.repeat(81), { name: 'a' })).toThrow(AppsError);
  });
});

describe('duplicateAppFiles', () => {
  it('copies the published files (not the preview) as version 1 of a new unpublished app with provenance', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const out = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'My wall', actor: copier, env: ON });
    expect(out.version).toBe(1);
    const [copy] = await db.select().from(apps).where(eq(apps.id, out.id));
    expect(copy).toMatchObject({
      workspaceId: copierWs,
      name: 'My wall',
      publishedVersionId: null,
      galleryListed: false,
      galleryAllowDuplicate: false,
      duplicatedFromAppId: app.id,
      duplicatedFromSlug: app.slug,
    });
    expect(copy.slug).toMatch(/^my-wall/);
    const v = await getVersion(out.id, { number: 1 });
    expect(v?.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['source:index.html', 'built:main.js']);
    expect(v?.compileStatus).toBe('ok');
    const html = await readVersionFile(v!.id, 'index.html');
    expect(html?.toString('utf8')).toBe('<h1>published</h1>');

    expect(await auditIn(copierWs, copy.slug)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'app.duplicate', meta: { from: app.slug, version: 1 }, actorUserId: copier.userId })])
    );
    const onSource = (await auditIn(authorWs, app.slug)).filter((a) => a.action === 'app.duplicated');
    expect(onSource).toEqual([{ action: 'app.duplicated', meta: {}, actorUserId: null }]);
  });

  it('the public list shows duplicable, the dashboard link and live copies', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const a = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'One', actor: copier, env: ON });
    await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'Two', actor: copier, env: ON });
    await softDeleteApp(a.id, copier);
    const { items } = await listGallery({ limit: 48, env: ON });
    const item = items.find((i) => i.url === `https://${app.slug}.apps.example.test`);
    expect(item).toMatchObject({ duplicable: true, duplicateUrl: `https://dash.example.test/duplicate/${app.slug}`, duplicates: 1 });
  });

  it('caps copies per person per hour (DUPLICATES_PER_USER_HOUR)', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const [u] = await db.insert(users).values({ email: 'busy@example.test' }).returning();
    const busy: Actor = { userId: u.id, kind: 'user' };
    const env = { ...ON, DUPLICATES_PER_USER_HOUR: '2' };
    expect(duplicatesPerUserHour(env)).toBe(2);
    expect(duplicatesPerUserHour({})).toBe(10);
    await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'a', actor: busy, env });
    await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'b', actor: busy, env });
    const err = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'c', actor: busy, env }).catch((e: AppsError) => e);
    expect(err).toMatchObject({ code: 'rate_limited', details: { limit: 'DUPLICATES_PER_USER_HOUR', value: 2 } });
  });

  it('parallel copies by one person share the cap: exactly the limit gets through', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const [u] = await db.insert(users).values({ email: 'racer@example.test' }).returning();
    const racer: Actor = { userId: u.id, kind: 'user' };
    const env = { ...ON, DUPLICATES_PER_USER_HOUR: '1' };
    const results = await Promise.allSettled(
      [copierWs, copierWs, authorWs].map((ws, i) => duplicateAppFiles({ source: src, workspaceId: ws, name: `race ${i}`, actor: racer, env }))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as AppsError).code);
    expect(refused).toEqual(['rate_limited', 'rate_limited']);
    const copies = await db.select({ id: apps.id }).from(apps).where(eq(apps.duplicatedFromAppId, app.id));
    expect(copies).toHaveLength(1);
  });

  it("the copy's version 1 counts against VERSIONS_PER_USER_HOUR, refused before the app exists", async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const [u] = await db.insert(users).values({ email: 'writer@example.test' }).returning();
    const writer: Actor = { userId: u.id, kind: 'user' };
    const versionLimits = { perApp: 600, perUser: 2 };
    const first = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'first', actor: writer, env: ON, versionLimits });
    await createVersion(first.id, [{ path: 'index.html', content: '<h1>mine</h1>' }], { actor: writer, versionLimits });
    const err = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'second', actor: writer, env: ON, versionLimits }).catch(
      (e: AppsError) => e
    );
    expect(err).toMatchObject({ code: 'rate_limited', details: { limit: 'VERSIONS_PER_USER_HOUR', value: 2 } });
    const copies = await db.select({ name: apps.name }).from(apps).where(eq(apps.duplicatedFromAppId, app.id));
    expect(copies.map((c) => c.name)).toEqual(['first']);
  });

  it('a copy refused before its app exists does not use up the cap', async () => {
    const app = await galleryApp();
    const src = await duplicationSource(app.slug, ON);
    const [u] = await db.insert(users).values({ email: 'full@example.test' }).returning();
    const person: Actor = { userId: u.id, kind: 'user' };
    const env = { ...ON, DUPLICATES_PER_USER_HOUR: '1' };
    const full = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'full', actor: person, env, maxApps: 1 }).catch((e: AppsError) => e);
    expect(full).toMatchObject({ code: 'limit_exceeded' });
    const ok = await duplicateAppFiles({ source: src, workspaceId: copierWs, name: 'fits', actor: person, env });
    expect(ok.version).toBe(1);
  });
});
