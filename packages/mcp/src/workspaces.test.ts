/**
 * create_workspace and invite_member over a real MCP client on a real
 * (PGlite) database: a new team workspace with the caller as its
 * workspace-admin (the dashboard's name and slug rules, slug_taken); an
 * invite only from a workspace-admin of a team workspace, only with
 * user_confirmed, e-mailed and audited `member.invite` with the agent as the
 * actor, the link never in the result; an e-mail that cannot be sent
 * withdraws the invite.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
let alice: ToolPrincipal;
let eddie: ToolPrincipal;
let teamId: string;
let deps: TestDeps;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [a] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [e] = await db.insert(users).values({ email: 'eddie@example.test' }).returning();
  const [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'team-i', name: 'Team I' }).returning();
  teamId = team.id;
  const [personal] = await db.insert(workspaces).values({ kind: 'personal', slug: 'alice', name: 'Alice' }).returning();
  await db.insert(memberships).values({ userId: a.id, workspaceId: team.id, role: 'workspace-admin' });
  await db.insert(memberships).values({ userId: a.id, workspaceId: personal.id, role: 'workspace-admin' });
  await db.insert(memberships).values({ userId: e.id, workspaceId: team.id, role: 'editor' });
  alice = { userId: a.id, email: 'alice@example.test', superAdmin: false };
  eddie = { userId: e.id, email: 'eddie@example.test', superAdmin: false };
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
  deps.env.PUBLIC_APP_URL = 'https://dash.drobek.test';
});

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function invites() {
  return db
    .select({ actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, teamId), eq(auditLog.action, 'member.invite')));
}

describe('create_workspace', () => {
  it('creates a team workspace with the caller as its workspace-admin; list_apps shows it; the slug is then taken', async () => {
    const c = await connect(alice, deps);
    try {
      const r = await c.call('create_workspace', { name: '  Field Team  ', slug: 'Field-Team' });
      expect(r.isError, r.text).toBe(false);
      expect(r.body).toMatchObject({
        workspace: 'field-team',
        name: 'Field Team',
        kind: 'team',
        role: 'workspace-admin',
        workspace_url: 'https://dash.drobek.test/workspaces/field-team',
      });
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, 'field-team'));
      const [m] = await db.select().from(memberships).where(eq(memberships.workspaceId, ws.id));
      expect(m).toMatchObject({ userId: alice.userId, role: 'workspace-admin' });

      const listed = (await c.call('list_apps', {})).body as { workspaces: { slug: string }[] };
      expect(listed.workspaces.map((w) => w.slug)).toContain('field-team');

      const created = await c.call('create_app', { name: 'Roster', workspace: 'field-team', template: 'html' });
      expect(created.isError, created.text).toBe(false);

      expect(errorOf(await c.call('create_workspace', { name: 'Other', slug: 'field-team' }))).toMatchObject({ code: 'slug_taken', slug: 'field-team' });
    } finally {
      await c.close();
    }
  });

  it('refuses an empty or too long name, a bad slug and a credential-looking name', async () => {
    const c = await connect(alice, deps);
    try {
      const empty = errorOf(await c.call('create_workspace', { name: '   ', slug: 'blank-name' }));
      expect(empty).toMatchObject({ code: 'invalid_params' });
      expect(String(empty.message)).toMatch(/^name: /);
      expect(errorOf(await c.call('create_workspace', { name: 'x'.repeat(81), slug: 'long-name' }))).toMatchObject({ code: 'invalid_params' });
      const slug = errorOf(await c.call('create_workspace', { name: 'Fine', slug: '-bad slug-' }));
      expect(String(slug.message)).toMatch(/^slug: /);
      const secret = errorOf(await c.call('create_workspace', { name: `sk_live_${'a1B2'.repeat(6)}`, slug: 'secret-name' }));
      expect(secret).toMatchObject({ code: 'invalid_params' });
      expect(await db.select().from(workspaces).where(eq(workspaces.slug, 'secret-name'))).toHaveLength(0);
    } finally {
      await c.close();
    }
  });
});

describe('invite_member', () => {
  it('asks for user_confirmed, then e-mails the invite and audits it as the agent — the link never comes back', async () => {
    const c = await connect(alice, deps);
    try {
      const ask = errorOf(await c.call('invite_member', { workspace: 'team-i', email: ' Ana@Example.COM ', role: 'editor' }));
      expect(ask).toMatchObject({ code: 'user_confirmation_required', workspace: 'team-i', email: 'ana@example.com', role: 'editor' });
      expect(deps.invited.sent).toHaveLength(0);
      expect(deps.invited.tokens.size).toBe(0);

      const r = await c.call('invite_member', { workspace: 'team-i', email: 'ana@example.com', role: 'editor', user_confirmed: true });
      expect(r.isError, r.text).toBe(false);
      expect(r.body).toMatchObject({ workspace: 'team-i', email: 'ana@example.com', role: 'editor', invited: true, expires_in_days: 7 });
      expect(deps.invited.sent).toEqual([
        expect.objectContaining({ email: 'ana@example.com', workspaceName: 'Team I', role: 'editor' }),
      ]);
      const [token] = [...deps.invited.tokens.keys()];
      expect(deps.invited.tokens.get(token)).toEqual({ workspaceId: teamId, role: 'editor', email: 'ana@example.com' });
      expect(deps.invited.sent[0].acceptUrl).toContain(token);
      expect(r.text).not.toContain(token);
      expect(r.text).not.toContain('/invite/');
      expect(await invites()).toEqual([{ actorKind: 'agent', actorUserId: alice.userId, meta: { role: 'editor' } }]);
    } finally {
      await c.close();
    }
  });

  it('an e-mail that cannot be sent withdraws the invite: unavailable, no token left, no audit row', async () => {
    const before = (await invites()).length;
    deps.invited.failNext = true;
    const c = await connect(alice, deps);
    try {
      const err = errorOf(await c.call('invite_member', { workspace: 'team-i', email: 'bo@example.com', role: 'viewer', user_confirmed: true }));
      expect(err).toMatchObject({ code: 'unavailable', reason: 'email_failed' });
      expect(String(err.message)).toContain('https://dash.drobek.test/workspaces/team-i/invite');
      expect(deps.invited.tokens.size).toBe(0);
      expect(await invites()).toHaveLength(before);
    } finally {
      await c.close();
    }
  });

  it('refuses an editor, a personal workspace, a bad address and an unknown role', async () => {
    const ce = await connect(eddie, deps);
    try {
      expect(errorOf(await ce.call('invite_member', { workspace: 'team-i', email: 'x@example.com', role: 'viewer', user_confirmed: true }))).toMatchObject({
        code: 'forbidden',
      });
    } finally {
      await ce.close();
    }
    const c = await connect(alice, deps);
    try {
      const personal = errorOf(await c.call('invite_member', { workspace: 'alice', email: 'x@example.com', role: 'viewer', user_confirmed: true }));
      expect(personal).toMatchObject({ code: 'invalid_params' });
      expect(String(personal.message)).toContain('personal workspace');
      expect(errorOf(await c.call('invite_member', { workspace: 'team-i', email: 'not an address', role: 'viewer', user_confirmed: true }))).toMatchObject({
        code: 'invalid_params',
      });
      expect((await c.call('invite_member', { workspace: 'team-i', email: 'x@example.com', role: 'owner', user_confirmed: true })).isError).toBe(true);
      expect(deps.invited.sent).toHaveLength(0);
      expect(deps.invited.tokens.size).toBe(0);
    } finally {
      await c.close();
    }
  });
});
