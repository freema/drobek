/**
 * listAdminWorkspaces on PGlite: the search by name, slug and admin e-mail,
 * the kind / apps / publishing chips, every sort (activity = the newest
 * version, publish or membership), the page boundaries, and the aggregates
 * (members, live and published apps, the first admin, the last activity) on
 * seeded data.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, appVersions, memberships, setDbForTests, users, workspaces } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { eq } from 'drizzle-orm';
import { listAdminWorkspaces, type AdminWorkspaceQuery } from './admin-workspaces.server.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12, 0, 0));

async function user(email: string): Promise<string> {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return u!.id;
}

async function workspace(slug: string, name: string, kind: 'personal' | 'team', createdAt: Date, extra: Partial<typeof workspaces.$inferInsert> = {}) {
  const [w] = await db.insert(workspaces).values({ slug, name, kind, createdAt, ...extra }).returning({ id: workspaces.id });
  return w!.id;
}

async function member(workspaceId: string, userId: string, role: 'viewer' | 'editor' | 'workspace-admin', createdAt: Date) {
  await db.insert(memberships).values({ workspaceId, userId, role, createdAt });
}

async function app(workspaceId: string, slug: string, opts: { versionsAt?: Date[]; publishedAt?: Date; deleted?: boolean } = {}) {
  const [a] = await db
    .insert(apps)
    .values({ workspaceId, slug: opts.deleted ? `${slug}~deleted-x1` : slug, deletedAt: opts.deleted ? day(1) : null })
    .returning({ id: apps.id });
  let last: string | null = null;
  for (const [i, at] of (opts.versionsAt ?? []).entries()) {
    const [v] = await db
      .insert(appVersions)
      .values({ appId: a!.id, number: i + 1, actorKind: 'agent', createdAt: at })
      .returning({ id: appVersions.id });
    last = v!.id;
  }
  if (opts.publishedAt && last) {
    await db.update(apps).set({ publishedVersionId: last, publishedAt: opts.publishedAt }).where(eq(apps.id, a!.id));
  }
}

const list = (q: Partial<AdminWorkspaceQuery> = {}) => listAdminWorkspaces({ pageSize: 50, ...q });
const slugs = async (q: Partial<AdminWorkspaceQuery> = {}) => (await list(q)).rows.map((r) => r.slug);

let ids: Record<string, string>;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  setDbForTests(db);

  const jana = await user('jana@example.test');
  const petr = await user('petr@example.test');
  const eva = await user('eva@acme.test');
  const otto = await user('otto@acme.test');

  // jana's personal workspace: one app with versions on day 3 and 10, published on day 11.
  const janaWs = await workspace('jana', 'Personal', 'personal', day(1));
  await member(janaWs, jana, 'workspace-admin', day(1));
  await app(janaWs, 'notes', { versionsAt: [day(3), day(10)], publishedAt: day(11) });

  // petr's personal workspace: nothing but the membership (day 2).
  const petrWs = await workspace('petr', 'Personal', 'personal', day(2));
  await member(petrWs, petr, 'workspace-admin', day(2));

  // Acme: a team with two admins (eva first), an editor who joined on day 20, three apps (one deleted), blocked.
  const acme = await workspace('acme', 'Acme Crew', 'team', day(5), { publishBlockedAt: day(6) });
  await member(acme, eva, 'workspace-admin', day(5));
  await member(acme, otto, 'workspace-admin', day(7));
  await member(acme, jana, 'editor', day(20));
  await app(acme, 'crm', { versionsAt: [day(8)], publishedAt: day(9) });
  await app(acme, 'wiki', { versionsAt: [day(12)] });
  await app(acme, 'old', { versionsAt: [day(25)], publishedAt: day(25), deleted: true });

  // Zeta: an approved team, created last, with no apps.
  const zeta = await workspace('zeta-50', 'zeta 50%', 'team', day(15), { publishApprovedAt: day(16) });
  await member(zeta, petr, 'workspace-admin', day(15));

  ids = { jana: janaWs, petr: petrWs, acme, zeta };
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

describe('listAdminWorkspaces', () => {
  it('aggregates members, live and published apps, the first admin and the last activity', async () => {
    const { rows, total, matching } = await list();
    expect({ total, matching }).toEqual({ total: 4, matching: 4 });
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(by.jana).toMatchObject({ id: ids.jana, kind: 'personal', adminEmail: 'jana@example.test', members: 1, apps: 1, publishedApps: 1, publishing: 'default' });
    expect(by.jana!.lastActivityAt?.toISOString()).toBe(day(11).toISOString());
    expect(by.petr).toMatchObject({ members: 1, apps: 0, publishedApps: 0 });
    expect(by.petr!.lastActivityAt?.toISOString()).toBe(day(2).toISOString());
    expect(by.acme).toMatchObject({ adminEmail: 'eva@acme.test', members: 3, apps: 2, publishedApps: 1, publishing: 'blocked' });
    expect(by.acme!.createdAt.toISOString()).toBe(day(5).toISOString());
    expect(by.acme!.lastActivityAt?.toISOString()).toBe(day(25).toISOString());
    expect(by['zeta-50']).toMatchObject({ adminEmail: 'petr@example.test', apps: 0, publishing: 'approved' });
  });

  it('searches the name, the slug and the e-mail of a workspace admin, case-insensitively and literally', async () => {
    expect(await slugs({ q: 'CREW' })).toEqual(['acme']);
    expect(await slugs({ q: 'pet' })).toEqual(['zeta-50', 'petr']);
    expect(await slugs({ q: 'otto@' })).toEqual(['acme']);
    expect(await slugs({ q: 'jana@example' })).toEqual(['jana']);
    expect(await slugs({ q: '50%' })).toEqual(['zeta-50']);
    expect(await slugs({ q: '_' })).toEqual([]);
    const none = await list({ q: 'nobody' });
    expect({ total: none.total, matching: none.matching, rows: none.rows }).toEqual({ total: 4, matching: 0, rows: [] });
  });

  it('filters by kind, apps and publishing', async () => {
    expect(await slugs({ kind: 'personal', sort: 'name' })).toEqual(['jana', 'petr']);
    expect(await slugs({ kind: 'team', sort: 'name' })).toEqual(['acme', 'zeta-50']);
    expect(await slugs({ apps: 'none', sort: 'name' })).toEqual(['petr', 'zeta-50']);
    expect(await slugs({ apps: 'some', sort: 'name' })).toEqual(['acme', 'jana']);
    expect(await slugs({ apps: 'published', kind: 'team' })).toEqual(['acme']);
    expect(await slugs({ publishing: 'blocked' })).toEqual(['acme']);
    expect(await slugs({ publishing: 'approved' })).toEqual(['zeta-50']);
    expect(await slugs({ publishing: 'default', sort: 'name' })).toEqual(['jana', 'petr']);
    expect((await list({ kind: 'team' })).matching).toBe(2);
  });

  it('sorts newest, oldest, by name, by apps and by last activity', async () => {
    expect(await slugs()).toEqual(['zeta-50', 'acme', 'petr', 'jana']);
    expect(await slugs({ sort: 'oldest' })).toEqual(['jana', 'petr', 'acme', 'zeta-50']);
    expect(await slugs({ sort: 'name' })).toEqual(['acme', 'jana', 'petr', 'zeta-50']);
    expect(await slugs({ sort: 'apps' })).toEqual(['acme', 'jana', 'petr', 'zeta-50']);
    expect(await slugs({ sort: 'activity' })).toEqual(['acme', 'zeta-50', 'jana', 'petr']);
  });

  it('pages: the boundaries, and a page past the last answers no rows with the counts', async () => {
    const one = await list({ sort: 'oldest', pageSize: 3 });
    expect(one.rows.map((r) => r.slug)).toEqual(['jana', 'petr', 'acme']);
    expect(one.matching).toBe(4);
    const two = await list({ sort: 'oldest', pageSize: 3, page: 2 });
    expect(two.rows.map((r) => r.slug)).toEqual(['zeta-50']);
    expect(two.matching).toBe(4);
    const exact = await list({ sort: 'oldest', pageSize: 2, page: 2 });
    expect(exact.rows.map((r) => r.slug)).toEqual(['acme', 'zeta-50']);
    const past = await list({ sort: 'oldest', pageSize: 2, page: 3 });
    expect(past).toEqual({ rows: [], total: 4, matching: 4 });
    const pastFiltered = await list({ kind: 'personal', pageSize: 1, page: 9 });
    expect(pastFiltered).toEqual({ rows: [], total: 4, matching: 2 });
  });
});
