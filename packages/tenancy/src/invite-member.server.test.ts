/**
 * inviteMember (the dashboard's Invite action and MCP invite_member) and
 * createTeamWorkspace's name rule against PGlite with the core migrations:
 * team-only, role and address checks, the token + e-mail through injected
 * deps, the `member.invite` audit row with the surface's actor kind, and an
 * invite that must be delivered withdrawn when its e-mail fails.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, setDbForTests, users, workspaces } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { inviteMember, normalizeInviteEmail, type MemberInviteDeps } from './invites.server.js';
import { createTeamWorkspace } from './team-workspace.server.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));
const ENV = { PUBLIC_APP_URL: 'https://dash.example' };

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ownerId: string;
let team: { id: string; name: string; kind: string };
let personal: { id: string; name: string; kind: string };
let tokens: Map<string, string | null>;
let sent: string[];
let failSend: boolean;
let deps: MemberInviteDeps;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning({ id: users.id });
  ownerId = u.id;
  [team] = await db.insert(workspaces).values({ kind: 'team', slug: 'crew', name: 'Crew' }).returning();
  [personal] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

beforeEach(() => {
  tokens = new Map();
  sent = [];
  failSend = false;
  let seq = 0;
  deps = {
    create: async (a) => {
      const token = (++seq).toString(16).padStart(64, 'a');
      tokens.set(token, a.email ?? null);
      return { token, id: token.slice(0, 16) };
    },
    withdraw: async (token) => {
      tokens.delete(token);
    },
    send: async (m) => {
      if (failSend) throw new Error('smtp down');
      sent.push(`${m.email} ${m.role} ${m.acceptUrl}`);
    },
  };
});

async function auditRows() {
  return db
    .select({ actorKind: auditLog.actorKind, meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, team.id), eq(auditLog.action, 'member.invite')));
}

describe('inviteMember', () => {
  it('a dashboard invite: e-mails the link, audits the role as the user and returns the link', async () => {
    const before = (await auditRows()).length;
    const out = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'editor', email: ' Ana@Example.com ', surface: 'web', deps, env: ENV });
    expect(out).toMatchObject({ ok: true, role: 'editor', email: 'ana@example.com', emailSent: true });
    if (!out.ok) return;
    expect(out.inviteUrl).toMatch(/^https:\/\/dash\.example\/invite\/[0-9a-f]{64}$/);
    expect(sent).toEqual([`ana@example.com editor ${out.inviteUrl}`]);
    expect((await auditRows()).slice(before)).toEqual([{ actorKind: 'user', meta: { role: 'editor' } }]);
  });

  it('a link-only dashboard invite sends nothing; a failed e-mail still keeps the dashboard invite', async () => {
    const linkOnly = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'viewer', email: '', surface: 'web', deps, env: ENV });
    expect(linkOnly).toMatchObject({ ok: true, email: null, emailSent: false });
    failSend = true;
    const failed = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'viewer', email: 'bo@example.com', surface: 'web', deps, env: ENV });
    expect(failed).toMatchObject({ ok: true, emailSent: false });
    expect(tokens.size).toBe(2);
  });

  it('an invite that must be delivered (MCP) is withdrawn when the e-mail fails — no token, no audit row — and needs an address', async () => {
    const before = (await auditRows()).length;
    failSend = true;
    const out = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'editor', email: 'cy@example.com', surface: 'mcp', requireDelivery: true, deps, env: ENV });
    expect(out).toMatchObject({ ok: false, reason: 'email-failed' });
    expect(tokens.size).toBe(0);
    expect(await auditRows()).toHaveLength(before);

    const none = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'editor', email: '', surface: 'mcp', requireDelivery: true, deps, env: ENV });
    expect(none).toMatchObject({ ok: false, reason: 'invalid-email' });

    failSend = false;
    const ok = await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'workspace-admin', email: 'cy@example.com', surface: 'mcp', requireDelivery: true, deps, env: ENV });
    expect(ok).toMatchObject({ ok: true, emailSent: true });
    expect((await auditRows()).slice(before)).toEqual([{ actorKind: 'agent', meta: { role: 'workspace-admin' } }]);
  });

  it('refuses a personal workspace, an unknown role and a malformed address before creating anything', async () => {
    expect(await inviteMember({ workspace: personal, invitedByUserId: ownerId, role: 'editor', email: 'a@example.com', surface: 'web', deps })).toMatchObject({
      ok: false,
      reason: 'not-team',
    });
    expect(await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'owner', email: 'a@example.com', surface: 'web', deps })).toMatchObject({
      ok: false,
      reason: 'invalid-role',
    });
    expect(await inviteMember({ workspace: team, invitedByUserId: ownerId, role: 'viewer', email: 'nope', surface: 'web', deps })).toMatchObject({
      ok: false,
      reason: 'invalid-email',
    });
    expect(tokens.size).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('normalizeInviteEmail', () => {
  it('trims and lower-cases one address; refuses anything else', () => {
    expect(normalizeInviteEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    for (const bad of ['', 'ana', 'ana@example', 'a b@example.com', 'a@b.c, d@e.f', `${'a'.repeat(250)}@example.com`]) {
      expect(normalizeInviteEmail(bad), bad).toBeNull();
    }
  });
});

describe('createTeamWorkspace', () => {
  it('trims the name, lower-cases the slug and refuses an empty or too long name', async () => {
    const ok = await createTeamWorkspace(ownerId, '  Night Shift ', 'Night-Shift');
    expect(ok).toMatchObject({ ok: true, workspace: { name: 'Night Shift', slug: 'night-shift', kind: 'team' } });
    expect(await createTeamWorkspace(ownerId, '   ', 'blank')).toEqual({ ok: false, reason: 'invalid-name', message: 'Enter a team name (1–80 characters).' });
    expect(await createTeamWorkspace(ownerId, 'x'.repeat(81), 'long')).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(await createTeamWorkspace(ownerId, 'Fine', 'no spaces')).toMatchObject({ ok: false, reason: 'invalid-slug' });
  });
});
