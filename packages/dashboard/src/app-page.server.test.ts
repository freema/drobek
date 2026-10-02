/**
 * appAction against a real PGlite database (the workspace role gate is
 * stubbed — requireWorkspaceRole has its own tests in @drobek/tenancy; the
 * lease read sees a free app): on a taken-down app publish / restore /
 * unpublish answer 423 `app_locked_by_admin` before anything changes, other
 * intents are not refused as locked; a restore past the workspace's version
 * rate answers 429 `rate_limited` with Retry-After.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, auditLog, setDbForTests, users, workspaces } from '@drobek/db';
import { setModuleRuntimeForTests } from '@drobek/modules';

const role = vi.hoisted(() => ({ user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string) => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    return { user: role.user, workspace: role.ws, membershipRole: 'editor', superAdmin: false, effectiveRole: 'editor' };
  },
}));

vi.mock('@drobek/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/core')>()),
  getRedis: () => ({ get: async () => null }),
}));

const { appAction } = await import('./app-page.server.js');

let pg: PGlite;
let appId: string;
let versionId: string;

function post(body: Record<string, string>, appSlug = 'taken-app') {
  const request = new Request(`https://drobek.example/workspaces/acme/apps/${appSlug}`, {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  return appAction({ request, params: { slug: 'acme', appSlug }, context: {} } as never);
}

function failed(res: unknown): { status: number; error: string; intent: string; headers: Record<string, string> } {
  const d = res as { data: { error: string; intent: string }; init: { status: number; headers?: Record<string, string> } };
  return { status: d.init?.status, error: d.data.error, intent: d.data.intent, headers: d.init?.headers ?? {} };
}

beforeAll(async () => {
  pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db
    .insert(apps)
    .values({ workspaceId: w.id, slug: 'taken-app', name: 'Taken', lockedReason: 'phishing' })
    .returning();
  appId = a.id;
  const [v] = await db
    .insert(appVersions)
    .values({ appId, number: 1, compileStatus: 'ok', createdByUserId: u.id, actorKind: 'user' })
    .returning();
  versionId = v.id;
});

afterAll(async () => {
  await pg.close();
});

describe('appAction on a taken-down app', () => {
  it('publish / restore / unpublish → 423 app_locked_by_admin, nothing changes', async () => {
    const bodies: Record<string, string>[] = [
      { intent: 'publish', versionId },
      { versionId }, // a publish form with only versionId
      { intent: 'publish', version: '1' },
      { intent: 'restore', version: '1' },
      { intent: 'unpublish' },
    ];
    for (const body of bodies) {
      const r = failed(await post(body));
      expect(r.status, JSON.stringify(body)).toBe(423);
      expect(r.error).toContain('taken down by the server operator');
      expect(r.error).toContain('phishing');
    }
    const db = drizzle(pg, { schema });
    const [row] = await db.select().from(apps).where(eq(apps.id, appId));
    expect(row.publishedVersionId).toBeNull();
    expect(await db.select().from(appVersions).where(eq(appVersions.appId, appId))).toHaveLength(1);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it('other intents are not refused as locked', async () => {
    expect(failed(await post({ intent: 'nope' }))).toMatchObject({ status: 400, error: 'Unknown action.' });
  });
});

describe('restore past the version rate', () => {
  it("answers 429 rate_limited with Retry-After from the workspace's VERSIONS_PER_APP_HOUR; nothing changes", async () => {
    const db = drizzle(pg, { schema });
    const [a] = await db.insert(apps).values({ workspaceId: role.ws.id, slug: 'busy-app', name: 'Busy' }).returning();
    await db.insert(appVersions).values({ appId: a.id, number: 1, compileStatus: 'ok', createdByUserId: role.user.id, actorKind: 'user' });
    setModuleRuntimeForTests({ workspaceLimits: async () => ({ VERSIONS_PER_APP_HOUR: 1 }) } as never);
    try {
      const r = failed(await post({ intent: 'restore', version: '1' }, 'busy-app'));
      expect(r).toMatchObject({ status: 429, intent: 'restore' });
      expect(r.error).toContain('VERSIONS_PER_APP_HOUR');
      expect(r.error).toContain('Try again in');
      expect(Number(r.headers['Retry-After'])).toBeGreaterThan(3500);
      expect(await db.select().from(appVersions).where(eq(appVersions.appId, a.id))).toHaveLength(1);
    } finally {
      setModuleRuntimeForTests(null);
    }
  });
});
