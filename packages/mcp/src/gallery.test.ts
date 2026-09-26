/**
 * NSO-340 over a real MCP client on a real (PGlite) database:
 * set_gallery_listing lists a published app only with `user_confirmed: true`
 * (the user's explicit yes), refuses an unpublished app, a bad description,
 * an entry the operator hid, a taken-down app, a viewer and a server without
 * a gallery; unlisting needs no confirmation; get_app shows the state; every
 * change is audited as the agent. (The publish-scope gate is @drobek/oauth's
 * TOOL_SCOPES — tools-list-scope.test.ts.)
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listGallery, setGalleryHidden, takedownApp } from '@drobek/apps';
import { apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let alice: ToolPrincipal;
let victor: ToolPrincipal;
let rootId: string;
let deps: TestDeps;

const ON = { APPS_DOMAIN: 'drobek.app', GALLERY_ENABLED: 'true' };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [v] = await db.insert(users).values({ email: 'victor@example.test' }).returning();
  const [r] = await db.insert(users).values({ email: 'root@example.test' }).returning();
  rootId = r.id;
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-g', name: 'Team G' }).returning();
  await db.insert(memberships).values({ userId: a.id, workspaceId: ws.id, role: 'editor' });
  await db.insert(memberships).values({ userId: v.id, workspaceId: ws.id, role: 'viewer' });
  alice = { userId: a.id, email: 'alice@example.test', superAdmin: false };
  victor = { userId: v.id, email: 'victor@example.test', superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
  deps.env = { ...ON };
});

type Client = Awaited<ReturnType<typeof connect>>;

async function newApp(c: Client, name: string, publish = true): Promise<{ app_id: string; slug: string }> {
  const r = await c.call('create_app', { name, workspace: 'team-g' });
  expect(r.isError, r.text).toBe(false);
  const app = r.body as { app_id: string; slug: string };
  if (publish) expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
  return app;
}

async function listedRow(appId: string) {
  const [row] = await db.select({ listed: apps.galleryListed, description: apps.galleryDescription }).from(apps).where(eq(apps.id, appId));
  return row;
}

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function inGallery(slug: string): Promise<boolean> {
  const { items } = await listGallery({ limit: 48, env: ON });
  return items.some((i) => i.url === `https://${slug}.drobek.app`);
}

describe('set_gallery_listing', () => {
  it('without user_confirmed nothing is listed; with it the app is listed and shows in the public list', async () => {
    const c = await connect(alice, deps);
    try {
      const app = await newApp(c, 'Shift Planner');
      const ask = errorOf(
        await c.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'Plan weekly shifts for a small team.' })
      );
      expect(ask).toMatchObject({ code: 'user_confirmation_required', description: 'Plan weekly shifts for a small team.' });
      expect(String(ask.message)).toMatch(/Ask the user whether they want "Shift Planner" in the public gallery/);
      expect(String(ask.hint)).toMatch(/user_confirmed:true only if they clearly say yes/);
      expect(await listedRow(app.app_id)).toMatchObject({ listed: false });
      // user_confirmed must be literally true.
      const notTrue = await c.call('set_gallery_listing', {
        app_id: app.app_id,
        listed: true,
        description: 'Plan weekly shifts for a small team.',
        user_confirmed: false,
      });
      expect(errorOf(notTrue).code).toBe('user_confirmation_required');

      const ok = await c.call('set_gallery_listing', {
        app_id: app.app_id,
        listed: true,
        description: 'Plan weekly shifts for a small team.',
        user_confirmed: true,
      });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.body).toEqual({
        app_id: app.app_id,
        listed: true,
        description: 'Plan weekly shifts for a small team.',
        changed: true,
        visible: true,
      });
      expect(await inGallery(app.slug)).toBe(true);

      const got = await c.call('get_app', { app_id: app.app_id });
      expect(got.body.gallery).toEqual({
        enabled: true,
        listed: true,
        description: 'Plan weekly shifts for a small team.',
        hidden_by_admin: false,
        visible: true,
      });

      const audit = await db
        .select({ action: auditLog.action, actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId })
        .from(auditLog)
        .where(and(eq(auditLog.target, app.slug), eq(auditLog.action, 'app.gallery_listed')));
      expect(audit).toEqual([{ action: 'app.gallery_listed', actorKind: 'agent', actorUserId: alice.userId }]);
    } finally {
      await c.close();
    }
  });

  it('unlisting needs no confirmation and takes effect at once', async () => {
    const c = await connect(alice, deps);
    try {
      const app = await newApp(c, 'Unlist Me');
      await c.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'Soon gone.', user_confirmed: true });
      expect(await inGallery(app.slug)).toBe(true);
      const off = await c.call('set_gallery_listing', { app_id: app.app_id, listed: false });
      expect(off.isError, off.text).toBe(false);
      expect(off.body).toMatchObject({ listed: false, changed: true, visible: false });
      expect(await inGallery(app.slug)).toBe(false);
      const again = await c.call('set_gallery_listing', { app_id: app.app_id, listed: false });
      expect(again.body).toMatchObject({ listed: false, changed: false });
    } finally {
      await c.close();
    }
  });

  it('refuses an unpublished app (before asking the user) and a bad description', async () => {
    const c = await connect(alice, deps);
    try {
      const draft = await newApp(c, 'Draft Only', false);
      const unpub = errorOf(await c.call('set_gallery_listing', { app_id: draft.app_id, listed: true, description: 'Hi.' }));
      expect(unpub.code).toBe('not_published');
      expect(String(unpub.hint)).toMatch(/Publish the app first/);

      const pub = await newApp(c, 'Bad Description');
      for (const description of [undefined, '', 'x'.repeat(161)]) {
        const r = errorOf(
          await c.call('set_gallery_listing', { app_id: pub.app_id, listed: true, description, user_confirmed: true })
        );
        expect(r.code, String(description)).toBe('invalid_params');
      }
      expect(await listedRow(pub.app_id)).toMatchObject({ listed: false });
    } finally {
      await c.close();
    }
  });

  it('an entry the operator hid cannot be listed (gallery_hidden); a taken-down app answers app_locked_by_admin', async () => {
    const c = await connect(alice, deps);
    try {
      const hidden = await newApp(c, 'Hidden One');
      await setGalleryHidden(hidden.app_id, true, rootId);
      const h = errorOf(
        await c.call('set_gallery_listing', { app_id: hidden.app_id, listed: true, description: 'Hi.', user_confirmed: true })
      );
      expect(h.code).toBe('gallery_hidden');
      expect((await c.call('get_app', { app_id: hidden.app_id })).body.gallery).toMatchObject({ hidden_by_admin: true, visible: false });

      const taken = await newApp(c, 'Taken One');
      await takedownApp({ appId: taken.app_id, reason: 'spam', actorUserId: rootId });
      const t = errorOf(
        await c.call('set_gallery_listing', { app_id: taken.app_id, listed: true, description: 'Hi.', user_confirmed: true })
      );
      expect(t.code).toBe('app_locked_by_admin');
    } finally {
      await c.close();
    }
  });

  it('a viewer gets forbidden', async () => {
    const owner = await connect(alice, deps);
    const viewer = await connect(victor, deps);
    try {
      const app = await newApp(owner, 'Viewer Target');
      const r = errorOf(
        await viewer.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'Hi.', user_confirmed: true })
      );
      expect(r.code).toBe('forbidden');
      expect(errorOf(await viewer.call('set_gallery_listing', { app_id: app.app_id, listed: false })).code).toBe('forbidden');
    } finally {
      await owner.close();
      await viewer.close();
    }
  });

  it('a server without a gallery answers gallery_disabled; get_app says enabled:false', async () => {
    const c = await connect(alice, deps);
    try {
      const app = await newApp(c, 'No Gallery Here');
      // The tool deps are resolved once per connection: switch the flag on the same env object.
      delete deps.env.GALLERY_ENABLED;
      const r = errorOf(await c.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'Hi.', user_confirmed: true }));
      expect(r.code).toBe('gallery_disabled');
      expect(errorOf(await c.call('set_gallery_listing', { app_id: app.app_id, listed: false })).code).toBe('gallery_disabled');
      expect((await c.call('get_app', { app_id: app.app_id })).body.gallery).toEqual({ enabled: false });
    } finally {
      await c.close();
    }
  });

  it('the rest of the MCP surface never lists an app: create → write → publish leaves it unlisted', async () => {
    const c = await connect(alice, deps);
    try {
      const app = await newApp(c, 'Plain Flow');
      await c.call('write_files', { app_id: app.app_id, files: [{ path: 'src/a.ts', content: 'export {}' }], reasoning: 'x' });
      await c.call('publish', { app_id: app.app_id });
      expect(await listedRow(app.app_id)).toMatchObject({ listed: false });
      // Of every tool, only set_gallery_listing takes a gallery argument.
      const tools = (await c.client.listTools()).tools;
      const withGallery = tools.filter((t) =>
        Object.keys((t.inputSchema.properties ?? {}) as object).some((k) => /listed|gallery|user_confirmed/i.test(k))
      );
      expect(withGallery.map((t) => t.name)).toEqual(['set_gallery_listing']);
    } finally {
      await c.close();
    }
  });
});
