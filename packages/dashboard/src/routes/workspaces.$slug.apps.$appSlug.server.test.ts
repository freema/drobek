/**
 * The Overview loader's QR codes against a real PGlite database (the role
 * gate and the insight panels are stubbed): an unpublished app has only the
 * preview's, a published one the production host's too, a verified primary
 * custom domain replaces the production host, and a password app says its
 * codes open the password page.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appVersions, apps, domains, setDbForTests, users, workspaces } from '@drobek/db';
import { setModuleRuntimeForTests } from '@drobek/modules';

const role = vi.hoisted(() => ({
  user: { id: '', email: 'owner@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme' },
}));

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

vi.mock('@drobek/insights', () => ({
  analyticsEnabled: () => false,
  queryAppErrors: async () => ({ totalEvents: 0, distinctErrors: 0, errors: [] }),
  queryAppLogs: async () => ({ requests: 0, count5xx: 0, top404Paths: [], recentVersions: [] }),
  queryTraffic: async () => null,
}));

const appsDomainBefore = process.env.APPS_DOMAIN;
process.env.APPS_DOMAIN = 'apps.example.com';

const { loader } = await import('./workspaces.$slug.apps.$appSlug.server.js');

let pg: PGlite;
let appId: string;
let versionId: string;

const db = () => drizzle(pg, { schema });
const load = () =>
  loader({ request: new Request('https://drobek.example/workspaces/acme/apps/notes'), params: { slug: 'acme', appSlug: 'notes' }, context: {} } as never);

beforeAll(async () => {
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  setModuleRuntimeForTests({ workspaceLimits: async () => ({}), appModules: async () => ({}) } as never);
  const [u] = await db().insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db().insert(apps).values({ workspaceId: w.id, slug: 'notes', name: 'Notes' }).returning();
  appId = a.id;
  const [v] = await db()
    .insert(appVersions)
    .values({ appId, number: 1, compileStatus: 'ok', createdByUserId: u.id, actorKind: 'user' })
    .returning();
  versionId = v.id;
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  if (appsDomainBefore === undefined) delete process.env.APPS_DOMAIN;
  else process.env.APPS_DOMAIN = appsDomainBefore;
  await pg.close();
});

describe('Overview loader: QR codes', () => {
  it('an unpublished app has only the preview QR', async () => {
    const { qr } = await load();
    expect(qr.preview.url).toBe('https://notes--preview.apps.example.com');
    expect(qr.preview.path).toMatch(/^M4 4h7v1h-7z/);
    expect(qr.live).toBeNull();
    expect(qr.passwordGate).toBe(false);
  });

  it('a published app gets the production host QR; a verified primary domain replaces it', async () => {
    await db().update(apps).set({ publishedVersionId: versionId }).where(eq(apps.id, appId));
    expect((await load()).qr.live?.url).toBe('https://notes.apps.example.com');

    await db().insert(domains).values({ appId, hostname: 'notes.example.org', verificationToken: 't1', isPrimary: true });
    expect((await load()).qr.live?.url).toBe('https://notes.apps.example.com');

    await db().update(domains).set({ verifiedAt: new Date() }).where(eq(domains.appId, appId));
    expect((await load()).qr.live?.url).toBe('https://notes.example.org');
  });

  it('a password app says its codes open the password page first', async () => {
    await db().update(apps).set({ visibility: 'password' }).where(eq(apps.id, appId));
    expect((await load()).qr.passwordGate).toBe(true);
  });
});
