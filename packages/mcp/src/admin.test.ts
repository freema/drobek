/**
 * The super-admin tools over a real MCP client on a real (PGlite) database:
 * set_workspace_module, takedown_app, restore_app and set_gallery_hidden are
 * listed only for a super-admin and their bodies refuse anyone else; a
 * change needs user_confirmed (a no-op answers changed: false without it);
 * the app is found by its app_id, its slug or an address; every change is
 * audited with the agent as the actor.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apps, auditLog, memberships, users, workspaceModules, workspaces } from '@drobek/db';
import { defineModule, loadModuleRuntime, memoryRateLimiter, z, type ModuleRuntime } from '@drobek/modules';
import { noopLogger } from '@drobek/core';
import { restoreAppTool, setGalleryHiddenTool, setWorkspaceModuleTool, takedownAppTool } from './admin.js';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';
import { greet } from './test/modules.js';

const vault = defineModule({
  name: 'files',
  version: '0.1.0',
  availability: 'opt-in',
  skill: { useWhen: 'the app needs the firm vault', markdown: '# files\n\nThe firm vault.\n' },
  configSchema: z.object({}),
  configDefaults: {},
});
const shelf = defineModule({
  name: 'shelf',
  version: '0.1.0',
  availability: 'opt-in',
  requires: ['files'],
  skill: { useWhen: 'the app shelves vault files', markdown: '# shelf\n\nShelves.\n' },
  configSchema: z.object({}),
  configDefaults: {},
});

let db: TestDb;
let close: () => Promise<void>;
let rt: ModuleRuntime;
let alice: ToolPrincipal;
let boss: ToolPrincipal;
let wsId: string;
let deps: TestDeps;

const SUPER_TOOLS = ['set_workspace_module', 'takedown_app', 'restore_app', 'set_gallery_hidden'];

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [b] = await db.insert(users).values({ email: 'boss@example.test' }).returning();
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-m', name: 'Team M' }).returning();
  wsId = ws.id;
  await db.insert(memberships).values({ userId: a.id, workspaceId: ws.id, role: 'workspace-admin' });
  alice = { userId: a.id, email: 'alice@example.test', superAdmin: false };
  boss = { userId: b.id, email: 'boss@example.test', superAdmin: true };
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '22'.repeat(32) },
    log: noopLogger,
    modules: [greet, vault, shelf],
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
  });
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
  deps.env.GALLERY_ENABLED = 'true';
  deps.modules = async () => rt;
});

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function agentAudit(action: string, target: string) {
  return db
    .select({ actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.target, target)));
}

async function publishedApp(name: string): Promise<{ app_id: string; slug: string }> {
  const c = await connect(alice, deps);
  try {
    const created = await c.call('create_app', { name, workspace: 'team-m', template: 'html' });
    expect(created.isError, created.text).toBe(false);
    const app = created.body as { app_id: string; slug: string };
    const p = await c.call('publish', { app_id: app.app_id });
    expect(p.isError, p.text).toBe(false);
    return app;
  } finally {
    await c.close();
  }
}

describe('who gets the super-admin tools', () => {
  it('a member does not see them in tools/list, and every body refuses a non-super-admin', async () => {
    const c = await connect(alice, deps);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      for (const t of SUPER_TOOLS) expect(names, t).not.toContain(t);
    } finally {
      await c.close();
    }
    const ctx = { principal: alice, sessionId: 's', deps, modules: rt };
    const calls = [
      setWorkspaceModuleTool(ctx, { workspace: 'team-m', module: 'files', enabled: true, user_confirmed: true }),
      takedownAppTool(ctx, { app: 'anything', reason: 'phishing', user_confirmed: true }),
      restoreAppTool(ctx, { app: 'anything', user_confirmed: true }),
      setGalleryHiddenTool(ctx, { app: 'anything', hidden: true, user_confirmed: true }),
    ];
    for (const call of calls) expect(await call.catch((e: unknown) => e)).toMatchObject({ code: 'forbidden' });
  });

  it('a super-admin sees all of them', async () => {
    const c = await connect(boss, deps);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      for (const t of [...SUPER_TOOLS, 'set_workspace_publishing']) expect(names, t).toContain(t);
    } finally {
      await c.close();
    }
  });
});

describe('set_workspace_module', () => {
  it('asks for user_confirmed, enables (audited as the agent), refuses a dependent before its requirement, disabling turns dependents off', async () => {
    const c = await connect(boss, deps);
    try {
      const refused = errorOf(await c.call('set_workspace_module', { workspace: 'team-m', module: 'shelf', enabled: true, user_confirmed: true }));
      expect(refused).toMatchObject({ code: 'module_requires_not_enabled', module: 'shelf', missing: ['files'] });

      const ask = errorOf(await c.call('set_workspace_module', { workspace: 'team-m', module: 'files', enabled: true }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', workspace: 'team-m', module: 'files', enabled: true });
      expect(String(ask.message)).toContain('user_confirmed: true only after they say yes');
      expect(await db.select().from(workspaceModules).where(eq(workspaceModules.workspaceId, wsId))).toHaveLength(0);

      const on = await c.call('set_workspace_module', { workspace: 'team-m', module: 'files', enabled: true, user_confirmed: true });
      expect(on.isError, on.text).toBe(false);
      expect(on.body).toMatchObject({ workspace: 'team-m', module: 'files', switch: true, enabled: true, source: 'dashboard', changed: true });
      expect(await agentAudit('module.workspace_enable', 'files')).toEqual([{ actorKind: 'agent', actorUserId: boss.userId, meta: { module: 'files' } }]);

      const again = await c.call('set_workspace_module', { workspace: 'team-m', module: 'files', enabled: true });
      expect(again.body).toMatchObject({ module: 'files', enabled: true, changed: false });

      const shelfOn = await c.call('set_workspace_module', { workspace: 'team-m', module: 'shelf', enabled: true, user_confirmed: true });
      expect(shelfOn.body).toMatchObject({ module: 'shelf', enabled: true, changed: true });

      const askOff = errorOf(await c.call('set_workspace_module', { workspace: 'team-m', module: 'files', enabled: false }));
      expect(askOff).toMatchObject({ code: 'user_confirmation_required', required_by: ['shelf'] });
      expect(String(askOff.message)).toContain('"shelf"');

      const off = await c.call('set_workspace_module', { workspace: 'team-m', module: 'files', enabled: false, user_confirmed: true });
      expect(off.body).toMatchObject({ module: 'files', switch: false, enabled: false, changed: true, dependents_off: ['shelf'] });
      expect((await agentAudit('module.workspace_disable', 'files'))[0]).toMatchObject({ actorKind: 'agent' });
    } finally {
      await c.close();
    }
  });

  it('an unknown or default module is not_found with the opt-in ones; an unknown workspace is not_found', async () => {
    const c = await connect(boss, deps);
    try {
      expect(errorOf(await c.call('set_workspace_module', { workspace: 'team-m', module: 'greet', enabled: true, user_confirmed: true }))).toMatchObject({
        code: 'not_found',
        available: ['files', 'shelf'],
      });
      expect(errorOf(await c.call('set_workspace_module', { workspace: 'nope', module: 'files', enabled: true, user_confirmed: true }))).toMatchObject({
        code: 'not_found',
      });
    } finally {
      await c.close();
    }
  });
});

describe('takedown_app and restore_app', () => {
  it('by slug: confirmation names what happens, the takedown is audited as the agent and locks the app; restore by address lifts it', async () => {
    const app = await publishedApp('Shady Page');
    const c = await connect(boss, deps);
    try {
      const ask = errorOf(await c.call('takedown_app', { app: app.slug, reason: 'phishing' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', app_id: app.app_id, app: app.slug, workspace: 'team-m', reason: 'phishing', published: true });
      expect(String(ask.message)).toContain(`https://${app.slug}.drobek.app`);
      expect((await db.select({ r: apps.lockedReason }).from(apps).where(eq(apps.id, app.app_id)))[0].r).toBeNull();

      const done = await c.call('takedown_app', { app: app.slug, reason: 'phishing', user_confirmed: true });
      expect(done.isError, done.text).toBe(false);
      expect(done.body).toMatchObject({ app_id: app.app_id, app: app.slug, taken_down: true, reason: 'phishing', changed: true, owners_emailed: 0 });
      const [row] = await db.select({ r: apps.lockedReason, pub: apps.publishedVersionId }).from(apps).where(eq(apps.id, app.app_id));
      expect(row.r).not.toBeNull();
      expect(row.pub).toBeNull();
      expect((await agentAudit('admin.takedown', app.slug))[0]).toMatchObject({ actorKind: 'agent', actorUserId: boss.userId });

      const twice = await c.call('takedown_app', { app: app.app_id, reason: 'malware' });
      expect(twice.body).toMatchObject({ taken_down: true, reason: 'phishing', changed: false });

      const ca = await connect(alice, deps);
      try {
        expect(errorOf(await ca.call('publish', { app_id: app.app_id }))).toMatchObject({ code: 'app_locked_by_admin' });
      } finally {
        await ca.close();
      }

      const askBack = errorOf(await c.call('restore_app', { app: `https://${app.slug}--preview.drobek.app/x` }));
      expect(askBack).toMatchObject({ code: 'user_confirmation_required', app_id: app.app_id, reason: 'phishing' });
      const back = await c.call('restore_app', { app: `${app.slug}--preview.drobek.app`, user_confirmed: true });
      expect(back.body).toMatchObject({ app_id: app.app_id, taken_down: false, changed: true });
      expect((await db.select({ r: apps.lockedReason }).from(apps).where(eq(apps.id, app.app_id)))[0].r).toBeNull();
      expect((await agentAudit('admin.restore', app.slug))[0]).toMatchObject({ actorKind: 'agent' });

      const idle = await c.call('restore_app', { app: app.app_id });
      expect(idle.body).toMatchObject({ taken_down: false, changed: false });
    } finally {
      await c.close();
    }
  });

  it('an unknown app or address is not_found; a bad reason or a malformed address is refused', async () => {
    const c = await connect(boss, deps);
    try {
      expect(errorOf(await c.call('takedown_app', { app: 'no-such-app', reason: 'spam', user_confirmed: true }))).toMatchObject({ code: 'not_found' });
      expect(errorOf(await c.call('restore_app', { app: 'unknown.example.com', user_confirmed: true }))).toMatchObject({ code: 'not_found' });
      expect(errorOf(await c.call('restore_app', { app: 'a b', user_confirmed: true }))).toMatchObject({ code: 'invalid_params' });
      expect((await c.call('takedown_app', { app: 'x', reason: 'boring', user_confirmed: true })).isError).toBe(true);
    } finally {
      await c.close();
    }
  });
});

describe('set_gallery_hidden', () => {
  it('hides only with user_confirmed (audited as the agent), set_gallery_listing then refuses it; showing it again works', async () => {
    const app = await publishedApp('Gallery Pick');
    const ca = await connect(alice, deps);
    try {
      const listed = await ca.call('set_gallery_listing', { app_id: app.app_id, listed: true, description: 'A pick for the gallery.', user_confirmed: true });
      expect(listed.isError, listed.text).toBe(false);
    } finally {
      await ca.close();
    }
    const c = await connect(boss, deps);
    try {
      const ask = errorOf(await c.call('set_gallery_hidden', { app: app.app_id, hidden: true }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', app_id: app.app_id, hidden: true, listed: true });

      const hid = await c.call('set_gallery_hidden', { app: app.slug, hidden: true, user_confirmed: true });
      expect(hid.body).toMatchObject({ app_id: app.app_id, hidden: true, listed: true, changed: true });
      expect((await db.select({ h: apps.galleryHiddenAt }).from(apps).where(eq(apps.id, app.app_id)))[0].h).not.toBeNull();
      expect((await agentAudit('app.gallery_hidden', app.slug))[0]).toMatchObject({ actorKind: 'agent', actorUserId: boss.userId });

      expect((await c.call('set_gallery_hidden', { app: app.slug, hidden: true })).body).toMatchObject({ changed: false });

      const shown = await c.call('set_gallery_hidden', { app: `${app.slug}.drobek.app`, hidden: false, user_confirmed: true });
      expect(shown.body).toMatchObject({ hidden: false, changed: true });
      expect((await db.select({ h: apps.galleryHiddenAt }).from(apps).where(eq(apps.id, app.app_id)))[0].h).toBeNull();
    } finally {
      await c.close();
    }
  });
});
