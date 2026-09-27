/**
 * NSO-366 over a real MCP client on a real (PGlite) database: with
 * PUBLISH_APPROVAL=approval, publish in an unapproved workspace answers
 * publish_not_approved with the operator's contact (and records the
 * approval request); list_apps / get_app say can_publish; a super-admin's
 * set_publish_approval approves / revokes only with user_confirmed: true,
 * audited as the agent; building and previews stay open.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { setPublishApprovalTool } from './publish-approval.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let alice: ToolPrincipal;
let boss: ToolPrincipal;
let wsId: string;
let deps: TestDeps;

const APPROVAL = { APPS_DOMAIN: 'drobek.app', PUBLISH_APPROVAL: 'approval', SUPERADMIN_EMAIL: 'boss@example.test', OPERATOR_EMAIL: 'ops@example.test' };

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
beforeEach(() => {
  deps = testDeps();
  deps.env = { ...APPROVAL };
});

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe('publish with PUBLISH_APPROVAL=approval', () => {
  it('an unapproved workspace builds and previews, but publish answers publish_not_approved with the contact', async () => {
    const c = await connect(alice, deps);
    try {
      const created = await c.call('create_app', { name: 'Gated', workspace: 'team-p' });
      expect(created.isError, created.text).toBe(false);
      const app = created.body as { app_id: string; preview_url: string };
      expect(app.preview_url).toContain('--preview.drobek.app');

      const listed = (await c.call('list_apps', {})).body as { workspaces: Record<string, unknown>[] };
      expect(listed.workspaces.find((w) => w.slug === 'team-p')).toMatchObject({ can_publish: false, publish_contact: 'ops@example.test' });
      expect((await c.call('get_app', { app_id: app.app_id })).body).toMatchObject({ can_publish: false, publish_contact: 'ops@example.test' });

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
    deps.env = { APPS_DOMAIN: 'drobek.app' };
    const c = await connect(alice, deps);
    try {
      const app = (await c.call('create_app', { name: 'Open', workspace: 'team-p' })).body as { app_id: string };
      const listed = (await c.call('list_apps', {})).body as { workspaces: Record<string, unknown>[] };
      expect(listed.workspaces.find((w) => w.slug === 'team-p')).toEqual(expect.objectContaining({ can_publish: true }));
      expect(listed.workspaces.find((w) => w.slug === 'team-p')).not.toHaveProperty('publish_contact');
      expect((await c.call('publish', { app_id: app.app_id })).isError).toBe(false);
    } finally {
      await c.close();
    }
  });
});

describe('set_publish_approval', () => {
  it('is only in a super-admin\'s tools/list, and the body refuses anyone else', async () => {
    const c = await connect(alice, deps);
    try {
      expect((await c.client.listTools()).tools.map((t) => t.name)).not.toContain('set_publish_approval');
    } finally {
      await c.close();
    }
    const direct = await setPublishApprovalTool(
      { principal: alice, sessionId: 's', deps, modules: await deps.modules() },
      { workspace: 'team-p', approved: true, user_confirmed: true }
    ).catch((e) => e);
    expect(direct).toMatchObject({ code: 'forbidden' });
  });

  it('asks for user_confirmed, then approves (audited as the agent); the workspace can publish; revoke takes it back', async () => {
    const c = await connect(boss, deps);
    try {
      const ask = errorOf(await c.call('set_publish_approval', { workspace: 'team-p', approved: true }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', workspace: 'team-p' });
      expect((await db.select().from(workspaces).where(eq(workspaces.id, wsId)))[0].publishApprovedAt).toBeNull();

      const ok = await c.call('set_publish_approval', { workspace: 'team-p', approved: true, user_confirmed: true });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.body).toMatchObject({ workspace: 'team-p', approved: true, changed: true, mode: 'approval' });
      expect(typeof ok.body.approved_at).toBe('string');

      const all = (await c.call('list_apps', {})).body as { all_workspaces: Record<string, unknown>[] };
      expect(all.all_workspaces.find((w) => w.slug === 'team-p')).toMatchObject({ can_publish: true });

      const ca = await connect(alice, deps);
      try {
        const app = (await ca.call('create_app', { name: 'Approved', workspace: 'team-p' })).body as { app_id: string };
        expect((await ca.call('publish', { app_id: app.app_id })).isError).toBe(false);
      } finally {
        await ca.close();
      }

      const revoked = await c.call('set_publish_approval', { workspace: 'team-p', approved: false, user_confirmed: true });
      expect(revoked.body).toMatchObject({ approved: false, approved_at: null, changed: true });
      const rows = await db
        .select({ action: auditLog.action, actorKind: auditLog.actorKind, target: auditLog.target })
        .from(auditLog)
        .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.actorUserId, boss.userId)));
      expect(rows).toEqual([
        { action: 'workspace.publish_approve', actorKind: 'agent', target: 'team-p' },
        { action: 'workspace.publish_revoke', actorKind: 'agent', target: 'team-p' },
      ]);
    } finally {
      await c.close();
    }
  });

  it('an unknown workspace is not_found', async () => {
    const c = await connect(boss, deps);
    try {
      expect(errorOf(await c.call('set_publish_approval', { workspace: 'nope', approved: true, user_confirmed: true }))).toMatchObject({ code: 'not_found' });
    } finally {
      await c.close();
    }
  });
});
