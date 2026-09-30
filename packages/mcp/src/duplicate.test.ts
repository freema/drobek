/**
 * duplicate_app over a real MCP client on a real (PGlite) database: the author
 * opens a listed app to duplicates (set_gallery_listing `allow_duplicate`,
 * inside the listing's confirmation); another user's duplicate_app copies the
 * published files into their personal workspace, proposes the module
 * settings through the copy's confirmation flow and get_app shows
 * `duplicated_from`; the refusals (not_duplicable, not_found,
 * gallery_disabled, a workspace the caller cannot edit, rate_limited).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, domains, memberships, moduleConfigs, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let author: ToolPrincipal;
let copier: ToolPrincipal;
let deps: TestDeps;

const ON = { APPS_DOMAIN: 'drobek.app', GALLERY_ENABLED: 'true', PUBLIC_APP_URL: 'https://dash.drobek.test' };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'author@example.test' }).returning();
  const [c] = await db.insert(users).values({ email: 'copier@example.test' }).returning();
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'makers', name: 'Makers' }).returning();
  const [ro] = await db.insert(workspaces).values({ kind: 'team', slug: 'watchers', name: 'Watchers' }).returning();
  await db.insert(memberships).values({ userId: a.id, workspaceId: ws.id, role: 'editor' });
  await db.insert(memberships).values({ userId: c.id, workspaceId: ro.id, role: 'viewer' });
  author = { userId: a.id, email: 'author@example.test', superAdmin: false };
  copier = { userId: c.id, email: 'copier@example.test', superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
  deps.env = { ...ON };
});

type Client = Awaited<ReturnType<typeof connect>>;

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function galleryApp(c: Client, name: string, allowDuplicate: boolean): Promise<{ app_id: string; slug: string }> {
  const r = await c.call('create_app', { name, workspace: 'makers', template: 'html' });
  expect(r.isError, r.text).toBe(false);
  const app = r.body as { app_id: string; slug: string };
  expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
  const ask = errorOf(
    await c.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'Paint pixels.', allow_duplicate: allowDuplicate })
  );
  expect(ask).toMatchObject({ code: 'user_confirmation_required', allow_duplicate: allowDuplicate });
  if (allowDuplicate) expect(String(ask.message)).toMatch(/copy its published files/);
  const ok = await c.call('set_gallery_listing', {
    app_id: app.app_id,
    listed: true,
    description: 'Paint pixels.',
    allow_duplicate: allowDuplicate,
    user_confirmed: true,
  });
  expect(ok.body).toMatchObject({ listed: true, allow_duplicate: allowDuplicate });
  return app;
}

describe('duplicate_app', () => {
  it('copies a duplicable gallery app into the caller\'s personal workspace', async () => {
    const a = await connect(author, deps);
    const c = await connect(copier, deps);
    try {
      const src = await galleryApp(a, 'Pixel Wall', true);
      await db.insert(moduleConfigs).values({ appId: src.app_id, module: 'greet', config: { audience: 'public', emoji: true } });
      const r = await c.call('duplicate_app', { from: `https://${src.slug}.drobek.app/`, name: 'My wall' });
      expect(r.isError, r.text).toBe(false);
      const out = r.body as Record<string, unknown> & { modules: { pending: { module: string; confirm_url: string }[] } };
      expect(out).toMatchObject({ version: 1, from: src.slug, workspace: expect.stringMatching(/^copier/) });
      expect(out.slug).toMatch(/^my-wall/);
      expect(out.preview_url).toBe(`https://${String(out.slug)}--preview.drobek.app`);
      expect(out.modules.pending).toEqual([
        { module: 'greet', changes: ['audience: anyone may call greet'], confirm_url: expect.stringContaining(`/apps/${String(out.slug)}/modules/greet`) },
      ]);
      expect(out.note).toMatch(/confirm/);

      const got = await c.call('get_app', { app_id: out.app_id });
      expect(got.body).toMatchObject({ duplicated_from: src.slug });
      expect(got.body).not.toHaveProperty('published_version');
      const [row] = await db.select().from(apps).where(eq(apps.id, String(out.app_id)));
      expect(row).toMatchObject({ duplicatedFromAppId: src.app_id, galleryListed: false });

      const bySlug = await c.call('duplicate_app', { from: src.slug });
      expect(bySlug.isError, bySlug.text).toBe(false);
      expect((bySlug.body as { slug: string }).slug).toMatch(/^pixel-wall-copy/);
    } finally {
      await a.close();
      await c.close();
    }
  });

  it('refuses an app its owner keeps closed, one outside the gallery, a server without a gallery and a workspace the caller cannot edit', async () => {
    const a = await connect(author, deps);
    const c = await connect(copier, deps);
    try {
      const closed = await galleryApp(a, 'Closed Wall', false);
      expect(errorOf(await c.call('duplicate_app', { from: closed.slug })).code).toBe('not_duplicable');
      expect(errorOf(await c.call('duplicate_app', { from: 'no-such-app' })).code).toBe('not_found');
      const open = await galleryApp(a, 'Open Wall', true);
      expect(errorOf(await c.call('duplicate_app', { from: open.slug, workspace: 'watchers' })).code).toBe('forbidden');
      deps.env = { ...ON, GALLERY_ENABLED: '' };
      const off = await connect(copier, deps);
      try {
        expect(errorOf(await off.call('duplicate_app', { from: open.slug })).code).toBe('gallery_disabled');
      } finally {
        await off.close();
      }
    } finally {
      await a.close();
      await c.close();
    }
  });

  it('caps copies per person per hour', async () => {
    const a = await connect(author, deps);
    try {
      const src = await galleryApp(a, 'Busy Wall', true);
      const [u] = await db.insert(users).values({ email: 'busy@example.test' }).returning();
      deps.env = { ...ON, DUPLICATES_PER_USER_HOUR: '1' };
      const b = await connect({ userId: u.id, email: 'busy@example.test', superAdmin: false }, deps);
      try {
        expect((await b.call('duplicate_app', { from: src.slug })).isError).toBe(false);
        expect(errorOf(await b.call('duplicate_app', { from: src.slug }))).toMatchObject({
          code: 'rate_limited',
          limit: 'DUPLICATES_PER_USER_HOUR',
          value: 1,
        });
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  });

  it('takes only addresses of this server: app hosts, a verified custom domain, the dashboard link', async () => {
    const a = await connect(author, deps);
    try {
      const src = await galleryApp(a, 'Address Wall', true);
      await db.insert(domains).values({ appId: src.app_id, hostname: 'wall.example.org', verificationToken: 't', verifiedAt: new Date() });
      await db.insert(domains).values({ appId: src.app_id, hostname: 'pending.example.org', verificationToken: 't' });
      const [u] = await db.insert(users).values({ email: 'addresses@example.test' }).returning();
      const b = await connect({ userId: u.id, email: 'addresses@example.test', superAdmin: false }, deps);
      try {
        for (const from of [
          `https://${src.slug}.other-instance.example/`,
          `${src.slug}.other-instance.example`,
          `https://other-instance.example/duplicate/${src.slug}`,
          `https://${src.slug}.drobek.app.other-instance.example/`,
          `https://${src.slug}.drobek.app:8443/`,
          'https://pending.example.org/',
          `https://dash.drobek.test/apps/${src.slug}`,
          `ftp://${src.slug}.drobek.app/`,
        ]) {
          const err = errorOf(await b.call('duplicate_app', { from }));
          expect(err, from).toMatchObject({ code: 'invalid_params' });
          expect(String(err.message), from).toMatch(/this server/);
        }
        const copied: string[] = [];
        for (const from of [
          `https://${src.slug}--preview.drobek.app/some/page`,
          `https://dash.drobek.test/duplicate/${src.slug}`,
          'https://wall.example.org/',
        ]) {
          const r = await b.call('duplicate_app', { from });
          expect(r.isError, `${from}: ${r.text}`).toBe(false);
          copied.push((r.body as { from: string }).from);
        }
        expect(copied).toEqual([src.slug, src.slug, src.slug]);
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  });
});
