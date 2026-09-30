/**
 * Workspace publishing over a real MCP client on a real (PGlite) database: publish in a
 * blocked workspace answers publish_blocked (both modes), in an unapproved
 * one (PUBLISH_APPROVAL=approval) publish_not_approved with the operator's
 * contact (and records the approval request); list_apps / get_app say
 * can_publish + publishing; a super-admin's set_workspace_publishing sets
 * default / allowed / blocked only with user_confirmed: true, audited as the
 * agent; building and previews stay open.
 */
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { setWorkspacePublishingTool } from './workspace-publishing.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let alice: ToolPrincipal;
let boss: ToolPrincipal;
let wsId: string;
let deps: TestDeps;

const OPEN = { APPS_DOMAIN: 'drobek.app', SUPERADMIN_EMAIL: 'boss@example.test', OPERATOR_EMAIL: 'ops@example.test' };
const APPROVAL = { ...OPEN, PUBLISH_APPROVAL: 'approval' };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [b] = await db.insert(users).values({ email: 'boss@example.test' }).returning();
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-p', name: 'Team P' }).returning();
  wsId = ws.id;
  await db.insert(memberships).values({ userId: a.id, workspaceId: ws.id, role: 'workspace-admin' });
  alice = { userId: a.id, email: 'alice@example.test', superAdmin: false };
  boss = { userId: b.id, email: 'boss@example.test', superAdmin: true };
});
afterAll(async () => close());
beforeEach(async () => {
  deps = testDeps();
  deps.env = { ...APPROVAL };
  await db
    .update(workspaces)
    .set({ publishApprovedAt: null, publishApprovedBy: null, publishBlockedAt: null, publishBlockedBy: null, publishApprovalRequestedAt: null })
    .where(eq(workspaces.id, wsId));
});

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function mine(c: Awaited<ReturnType<typeof connect>>): Promise<Record<string, unknown> | undefined> {
  const listed = (await c.call('list_apps', {})).body as { workspaces: Record<string, unknown>[] };
  return listed.workspaces.find((w) => w.slug === 'team-p');
}

describe('publish with PUBLISH_APPROVAL=approval', () => {
  it('an unapproved workspace builds and previews, but publish answers publish_not_approved with the contact', async () => {
    const c = await connect(alice, deps);
    try {
      const created = await c.call('create_app', { name: 'Gated', workspace: 'team-p' });
      expect(created.isError, created.text).toBe(false);
      const app = created.body as { app_id: string; preview_url: string };
      expect(app.preview_url).toContain('--preview.drobek.app');

      expect(await mine(c)).toMatchObject({ can_publish: false, publish_contact: 'ops@example.test', publishing: 'default' });
      expect((await c.call('get_app', { app_id: app.app_id })).body).toMatchObject({
        can_publish: false,
        publish_contact: 'ops@example.test',
        publishing: 'default',
      });

      const err = errorOf(await c.call('publish', { app_id: app.app_id }));
      expect(err).toMatchObject({ code: 'publish_not_approved', contact: 'ops@example.test' });
      expect(String(err.message)).toContain('needs approval from ops@example.test');
      expect(String(err.message)).toContain('An approval request was sent to ops@example.test');
      expect(String(err.hint)).toMatch(/Do not retry/);
      const [w] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      expect(w.publishApprovalRequestedBy).toBe(alice.userId);
    } finally {
      await c.close();
    }
  });

  it('open mode: can_publish is true and publish works', async () => {
    deps.env = { ...OPEN };
    const c = await connect(alice, deps);
    try {
      const app = (await c.call('create_app', { name: 'Open', workspace: 'team-p' })).body as { app_id: string };
      const w = await mine(c);
      expect(w).toEqual(expect.objectContaining({ can_publish: true, publishing: 'default' }));
      expect(w).not.toHaveProperty('publish_contact');
      expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
    } finally {
      await c.close();
    }
  });
});

describe('set_workspace_publishing', () => {
  it('is only in a super-admin\'s tools/list, and the body refuses anyone else', async () => {
    const c = await connect(alice, deps);
    try {
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('set_workspace_publishing');
      expect(names).not.toContain('set_publish_approval'); // doc-lint: allow — the v0.3.0 name, asserted gone
    } finally {
      await c.close();
    }
    const direct = await setWorkspacePublishingTool(
      { principal: alice, sessionId: 's', deps, modules: await deps.modules() },
      { workspace: 'team-p', publishing: 'allowed', user_confirmed: true }
    ).catch((e) => e);
    expect(direct).toMatchObject({ code: 'forbidden' });
  });

  it('asks for user_confirmed, then allows (audited as the agent); the workspace can publish; default takes it back', async () => {
    const c = await connect(boss, deps);
    try {
      const ask = errorOf(await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'allowed' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', workspace: 'team-p', publishing: 'allowed' });
      expect((await db.select().from(workspaces).where(eq(workspaces.id, wsId)))[0].publishApprovedAt).toBeNull();

      const ok = await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'allowed', user_confirmed: true });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.body).toEqual({ workspace: 'team-p', publishing: 'allowed', mode: 'approval', can_publish_now: true, changed: true });

      const all = (await c.call('list_apps', {})).body as { all_workspaces: Record<string, unknown>[] };
      expect(all.all_workspaces.find((w) => w.slug === 'team-p')).toMatchObject({ can_publish: true, publishing: 'allowed' });

      const ca = await connect(alice, deps);
      try {
        const app = (await ca.call('create_app', { name: 'Approved', workspace: 'team-p' })).body as { app_id: string };
        expect((await ca.call('publish', { app_id: app.app_id })).isError).toBe(false);
      } finally {
        await ca.close();
      }

      const back = await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'default', user_confirmed: true });
      expect(back.body).toEqual({ workspace: 'team-p', publishing: 'default', mode: 'approval', can_publish_now: false, changed: true });
      const again = await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'default', user_confirmed: true });
      expect(again.body).toMatchObject({ changed: false });
    } finally {
      await c.close();
    }
  });

  it('blocked refuses publish with publish_blocked in open mode (no approval request); unblocking lets it publish again', async () => {
    deps.env = { ...OPEN };
    const c = await connect(boss, deps);
    const ca = await connect(alice, deps);
    try {
      const app = (await ca.call('create_app', { name: 'Blocked', workspace: 'team-p' })).body as { app_id: string };
      const blocked = await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'blocked', user_confirmed: true });
      expect(blocked.body).toEqual({ workspace: 'team-p', publishing: 'blocked', mode: 'open', can_publish_now: false, changed: true });

      expect(await mine(ca)).toMatchObject({ can_publish: false, publish_contact: 'ops@example.test', publishing: 'blocked' });
      const err = errorOf(await ca.call('publish', { app_id: app.app_id }));
      expect(err).toMatchObject({
        code: 'publish_blocked',
        contact: 'ops@example.test',
        message:
          'Publishing from this workspace was turned off by the operator of this server (ops@example.test). Previews, versions and everything else keep working; live apps keep serving unless taken down.',
      });
      expect(String(err.hint)).toMatch(/Do not retry/);
      expect((await db.select().from(workspaces).where(eq(workspaces.id, wsId)))[0].publishApprovalRequestedAt).toBeNull();

      const unblocked = await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'default', user_confirmed: true });
      expect(unblocked.body).toMatchObject({ publishing: 'default', can_publish_now: true, changed: true });
      expect((await ca.call('publish', { app_id: app.app_id })).isError).toBe(false);

      const rows = await db
        .select({ action: auditLog.action, actorKind: auditLog.actorKind, target: auditLog.target })
        .from(auditLog)
        .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.actorUserId, boss.userId), like(auditLog.action, 'workspace.publish_%')));
      expect(rows.slice(-2)).toEqual([
        { action: 'workspace.publish_block', actorKind: 'agent', target: 'team-p' },
        { action: 'workspace.publish_unblock', actorKind: 'agent', target: 'team-p' },
      ]);
    } finally {
      await ca.close();
      await c.close();
    }
  });

  it('an unknown workspace is not_found; an unknown state is refused', async () => {
    const c = await connect(boss, deps);
    try {
      expect(errorOf(await c.call('set_workspace_publishing', { workspace: 'nope', publishing: 'allowed', user_confirmed: true }))).toMatchObject({
        code: 'not_found',
      });
      expect((await c.call('set_workspace_publishing', { workspace: 'team-p', publishing: 'approved', user_confirmed: true })).isError).toBe(true);
    } finally {
      await c.close();
    }
  });
});
