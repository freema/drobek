/**
 * The Assets tab's actions (NSO-358) against a real PGlite database (the
 * workspace role gate is stubbed — requireWorkspaceRole has its own tests in
 * @drobek/tenancy): an editor gets a single-use upload URL on the dashboard
 * host bound to the app, the path, the size and themselves (the dashboard
 * side of create_asset_upload), the same refusals as the MCP tool, delete is
 * audited `asset.delete`; a viewer is refused, a taken-down app answers 423.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { appAssets, apps, auditLog, setDbForTests, users, workspaces } from '@drobek/db';
import { hashUploadToken, memoryUploadTokenStore } from '@drobek/apps';
import { noopLogger } from '@drobek/core';
import { loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests } from '@drobek/modules';

const role = vi.hoisted(() => ({ current: 'editor' as 'viewer' | 'editor', user: { id: '', email: 'owner@example.com' }, ws: { id: '', slug: 'acme', name: 'Acme' } }));

vi.mock('@drobek/tenancy', () => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    requireWorkspaceRole: async (_request: Request, slug: string, min: keyof typeof rank) => {
      if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
      if (rank[role.current] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: role.user, workspace: role.ws, membershipRole: role.current, superAdmin: false, effectiveRole: role.current };
    },
  };
});

const tab = await import('./workspaces.$slug.apps.$appSlug.assets.server.js');

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  DROBEK_MASTER_KEY: '33'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

let pg: PGlite;
let appId: string;
let assetsDir: string;
let savedDir: string | undefined;
let tokens: ReturnType<typeof memoryUploadTokenStore>;
let budget: number;
const db = () => drizzle(pg, { schema });
const url = 'https://drobek.example/workspaces/acme/apps/shop-app/assets';
const params = { slug: 'acme', appSlug: 'shop-app' };

const post = (body: Record<string, string>) =>
  tab.action({ request: new Request(url, { method: 'POST', body: new URLSearchParams(body) }), params, context: {} } as never);
const result = (res: unknown) => {
  const d = res as { data: Record<string, unknown>; init: { status: number } | null };
  return { status: d.init?.status ?? 200, body: d.data };
};

beforeAll(async () => {
  savedDir = process.env.ASSETS_DIR;
  assetsDir = mkdtempSync(join(tmpdir(), 'drobek-dash-assets-'));
  process.env.ASSETS_DIR = assetsDir;
  pg = new PGlite();
  await migrate(db(), {
    migrationsFolder: fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db());
  const [u] = await db().insert(users).values({ email: 'owner@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db().insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name };
  const [a] = await db().insert(apps).values({ workspaceId: w.id, slug: 'shop-app', name: 'Shop' }).returning();
  appId = a.id;
  setModuleRuntimeForTests(
    await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    })
  );
  tab.assetsTabDeps.tokens = () => tokens;
  tab.assetsTabDeps.uploadAllowed = async () => budget-- > 0;
  tab.assetsTabDeps.env = () => ENV;
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  if (savedDir === undefined) delete process.env.ASSETS_DIR;
  else process.env.ASSETS_DIR = savedDir;
  rmSync(assetsDir, { recursive: true, force: true });
  await pg.close();
});

beforeEach(async () => {
  role.current = 'editor';
  tokens = memoryUploadTokenStore();
  budget = 100;
  await db().delete(appAssets);
  await db().delete(auditLog);
  await db().update(apps).set({ lockedReason: null }).where(eq(apps.id, appId));
});

describe('intent=upload-url', () => {
  it('mints a single-use URL on the dashboard host for this user, path and size', async () => {
    const r = result(await post({ intent: 'upload-url', path: 'media/film.mp4', size: '26214400', type: 'video/mp4' }));
    expect(r.status).toBe(200);
    expect(r.body.uploadUrl).toMatch(/^https:\/\/drobek\.example\/api\/assets\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({ intent: 'upload-url', assetPath: '/media/film.mp4', curl: `curl -T film.mp4 '${String(r.body.uploadUrl)}'` });
    const token = String(r.body.uploadUrl).split('/').pop()!;
    expect(await tokens.peek(hashUploadToken(token))).toMatchObject({
      appId,
      appSlug: 'shop-app',
      name: 'media/film.mp4',
      size: 26214400,
      userId: role.user.id,
      actorKind: 'user',
      via: 'dashboard',
    });
  });

  it('refuses like the MCP tool: bad path, too large, wrong type; the hourly budget; a viewer; a taken-down app', async () => {
    expect(result(await post({ intent: 'upload-url', path: '../x.mp4', size: '10' })).body.code).toBe('invalid_params');
    const big = result(await post({ intent: 'upload-url', path: 'film.mp4', size: String(200 * 1024 * 1024) }));
    expect(big).toMatchObject({ status: 413, body: { code: 'asset_too_large' } });
    expect(result(await post({ intent: 'upload-url', path: 'film.mp4', size: '10', type: 'text/html' })).body.code).toBe('asset_type_not_allowed');
    budget = 0;
    expect(result(await post({ intent: 'upload-url', path: 'film.mp4', size: '10' }))).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    expect(tokens.size()).toBe(0);
    role.current = 'viewer';
    const refused = await post({ intent: 'upload-url', path: 'film.mp4', size: '10' }).catch((e: unknown) => e);
    expect((refused as Response).status).toBe(403);
    role.current = 'editor';
    await db().update(apps).set({ lockedReason: 'phishing' }).where(eq(apps.id, appId));
    expect(result(await post({ intent: 'upload-url', path: 'film.mp4', size: '10' }))).toMatchObject({ status: 423, body: { code: 'app_locked_by_admin' } });
  });
});

describe('intent=delete', () => {
  it('removes the asset and audits asset.delete as the dashboard user; a missing path is 404', async () => {
    await db().insert(appAssets).values({ appId, name: 'film.mp4', contentType: 'video/mp4', size: 10, sha256: 'a'.repeat(64), storageKey: 'b'.repeat(32) });
    const res = (await post({ intent: 'delete', path: '/film.mp4' })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/workspaces/acme/apps/shop-app/assets');
    expect(await db().select().from(appAssets)).toEqual([]);
    const rows = await db().select().from(auditLog);
    expect(rows.map((r) => ({ action: r.action, actor: r.actorUserId, kind: r.actorKind, meta: r.meta }))).toEqual([
      { action: 'asset.delete', actor: role.user.id, kind: 'user', meta: { name: 'film.mp4', size: 10, via: 'dashboard' } },
    ]);
    expect(result(await post({ intent: 'delete', path: 'film.mp4' }))).toMatchObject({ status: 404, body: { code: 'asset_not_found' } });
  });
});
