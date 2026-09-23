/**
 * appAction on a taken-down app (NSO-293 × NSO-288) against a real PGlite
 * database (the workspace role gate is stubbed — requireWorkspaceRole has its
 * own tests in @drobek/tenancy): publish / restore / unpublish answer 423
 * `app_locked_by_admin` before anything changes; other intents are not
 * refused as locked.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, auditLog, setDbForTests, users, workspaces } from '@drobek/db';

const role = vi.hoisted(() => ({ user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string) => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    return { user: role.user, workspace: role.ws, membershipRole: 'editor', superAdmin: false, effectiveRole: 'editor' };
  },
}));

const { appAction } = await import('./app-page.server.js');

let pg: PGlite;
let appId: string;
let versionId: string;

function post(body: Record<string, string>) {
  const request = new Request('https://drobek.example/workspaces/acme/apps/taken-app', {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  return appAction({ request, params: { slug: 'acme', appSlug: 'taken-app' }, context: {} } as never);
}

function failed(res: unknown): { status: number; error: string; intent: string } {
  const d = res as { data: { error: string; intent: string }; init: { status: number } };
  return { status: d.init?.status, error: d.data.error, intent: d.data.intent };
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

describe('appAction on a taken-down app (NSO-293)', () => {
  it('publish / restore / unpublish → 423 app_locked_by_admin, nothing changes', async () => {
    const bodies: Record<string, string>[] = [
      { intent: 'publish', versionId },
      { versionId }, // a pre-NSO-288 publish form
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
