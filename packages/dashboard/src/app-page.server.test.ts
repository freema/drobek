/**
 * appAction against a real PGlite database (the workspace role gate is
 * stubbed — requireWorkspaceRole has its own tests in @drobek/tenancy; the
 * lease read sees a free app): on a taken-down app publish / restore /
 * unpublish answer 423 `app_locked_by_admin` before anything changes, other
 * intents are not refused as locked; a restore past the workspace's version
 * rate answers 429 `rate_limited` with Retry-After; keep / unkeep and the
 * history clean-up (a viewer → 403, an unconfirmed clean-up changes nothing,
 * the APP_VERSIONS_KEPT_MAX message, a clean-up of a taken-down app → 423
 * while keeping still works there).
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

const role = vi.hoisted(() => ({
  user: { id: '', email: 'owner@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme' },
  effective: 'editor' as 'viewer' | 'editor',
}));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string, minRole: 'viewer' | 'editor') => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    if (minRole === 'editor' && role.effective === 'viewer') throw new Response('Forbidden', { status: 403 });
    return { user: role.user, workspace: role.ws, membershipRole: role.effective, superAdmin: false, effectiveRole: role.effective };
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

describe('keep / unkeep and the history clean-up', () => {
  const db = () => drizzle(pg, { schema });

  async function seedApp(slug: string, versions: { number: number; compileStatus?: 'ok' | 'error' }[], hoursAgo = 2) {
    const [a] = await db().insert(apps).values({ workspaceId: role.ws.id, slug, name: slug }).returning();
    for (const v of versions) {
      await db()
        .insert(appVersions)
        .values({
          appId: a.id,
          number: v.number,
          compileStatus: v.compileStatus ?? 'ok',
          createdByUserId: role.user.id,
          actorKind: 'agent',
          createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
        });
    }
    return a.id;
  }
  const numbers = async (appId: string) =>
    (await db().select({ n: appVersions.number }).from(appVersions).where(eq(appVersions.appId, appId)))
      .map((r) => r.n)
      .sort((x, y) => x - y);
  const auditFor = async (slug: string) => (await db().select().from(auditLog).where(eq(auditLog.target, slug))).map((r) => r.action);
  const location = (res: unknown) => {
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    return (res as Response).headers.get('Location') ?? '';
  };

  it('a viewer gets 403 for keep, unkeep and delete-versions; nothing changes', async () => {
    const appId = await seedApp('viewer-app', [{ number: 1 }, { number: 2 }, { number: 3 }]);
    role.effective = 'viewer';
    try {
      const bodies: Record<string, string>[] = [
        { intent: 'keep', version: '1' },
        { intent: 'unkeep', version: '1' },
        { intent: 'delete-versions', upTo: '2', confirmed: '1' },
      ];
      for (const body of bodies) {
        const err = await post(body, 'viewer-app').then(
          () => null,
          (e: unknown) => e
        );
        expect(err, JSON.stringify(body)).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(403);
      }
    } finally {
      role.effective = 'editor';
    }
    expect(await numbers(appId)).toEqual([1, 2, 3]);
    expect(await auditFor('viewer-app')).toEqual([]);
  });

  it('keep past APP_VERSIONS_KEPT_MAX answers 400 with the limit message; unkeep says when the retention will delete it', async () => {
    await seedApp('keep-app', [{ number: 1 }, { number: 2 }, { number: 3 }]);
    setModuleRuntimeForTests({ workspaceLimits: async () => ({ APP_VERSIONS_KEPT_MAX: 1, APP_VERSIONS_KEEP: 1 }) } as never);
    try {
      expect(location(await post({ intent: 'keep', version: '1', redirectTo: '/workspaces/acme/apps/keep-app?before=3' }, 'keep-app'))).toBe(
        '/workspaces/acme/apps/keep-app?before=3&keptVersion=1'
      );
      const capped = failed(await post({ intent: 'keep', version: '2' }, 'keep-app'));
      expect(capped).toMatchObject({ status: 400, intent: 'keep' });
      expect(capped.error).toContain('APP_VERSIONS_KEPT_MAX');
      expect(capped.error).toContain('Stop keeping a version');
      expect(location(await post({ intent: 'unkeep', version: '1' }, 'keep-app'))).toBe(
        '/workspaces/acme/apps/keep-app?unkeptVersion=1&prunable=1'
      );
      expect(failed(await post({ intent: 'keep', version: 'x' }, 'keep-app'))).toMatchObject({ status: 400, error: 'Pick a version to keep.' });
      expect(failed(await post({ intent: 'keep', version: '99' }, 'keep-app'))).toMatchObject({ status: 400, intent: 'keep' });
    } finally {
      setModuleRuntimeForTests(null);
    }
    expect(await auditFor('keep-app')).toEqual(['app.version.keep', 'app.version.unkeep']);
  });

  it('an unconfirmed clean-up deletes nothing; a confirmed one recomputes what goes and redirects with the result', async () => {
    const appId = await seedApp('clean-app', [
      { number: 1 },
      { number: 2, compileStatus: 'error' },
      { number: 3, compileStatus: 'error' },
      { number: 4 },
      { number: 5 },
    ]);
    const unconfirmed = failed(await post({ intent: 'delete-versions', upTo: '4' }, 'clean-app'));
    expect(unconfirmed).toMatchObject({ status: 400, intent: 'delete-versions' });
    expect(unconfirmed.error).toContain('Nothing was deleted');
    expect(await numbers(appId)).toEqual([1, 2, 3, 4, 5]);
    expect(await auditFor('clean-app')).toEqual([]);

    expect(failed(await post({ intent: 'delete-versions', upTo: '0', confirmed: '1' }, 'clean-app'))).toMatchObject({ status: 400 });

    expect(location(await post({ intent: 'delete-versions', upTo: '4', failedOnly: '1', confirmed: '1' }, 'clean-app'))).toBe(
      '/workspaces/acme/apps/clean-app?deletedCount=2&deletedRanges=2-3&deletedFailedOnly=1'
    );
    expect(await numbers(appId)).toEqual([1, 4, 5]);

    // v5 is the preview and the newest: it stays.
    expect(location(await post({ intent: 'delete-versions', upTo: '5', confirmed: '1' }, 'clean-app'))).toBe(
      '/workspaces/acme/apps/clean-app?deletedCount=2&deletedRanges=1%2C4&stayed=1'
    );
    expect(await numbers(appId)).toEqual([5]);
    expect(await auditFor('clean-app')).toEqual(['app.versions.delete', 'app.versions.delete']);
  });

  it('on a taken-down app the clean-up answers 423 and keeping still works', async () => {
    const locked = failed(await post({ intent: 'delete-versions', upTo: '1', confirmed: '1' }));
    expect(locked.status).toBe(423);
    expect(locked.error).toContain('taken down by the server operator');
    expect(await db().select().from(appVersions).where(eq(appVersions.appId, appId))).toHaveLength(1);
    expect(location(await post({ intent: 'keep', version: '1' }))).toBe('/workspaces/acme/apps/taken-app?keptVersion=1');
    const [row] = await db().select().from(appVersions).where(eq(appVersions.appId, appId));
    expect(row.keptAt).not.toBeNull();
  });
});
