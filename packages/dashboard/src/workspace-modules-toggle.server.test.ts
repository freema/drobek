/**
 * NSO-346: /workspaces/:slug/modules — the opt-in switch per workspace, on a
 * real PGlite database (the workspace role gate is stubbed — it has its own
 * tests in @drobek/tenancy). The page is readable by every member (NSO-347):
 *  - a viewer / editor / workspace admin sees the opt-in modules read-only
 *    (canToggle false) and gets 403 from the switch, nothing changes; only a
 *    workspace admin sees which super-admin switched a module on;
 *  - a super-admin enables / disables (row + audit module.workspace_enable /
 *    module.workspace_disable, meta.module); the state shows who and the source;
 *  - a default or unknown module → 404; another intent → 400.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { auditLog, setDbForTests, users, workspaceModules, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { defineModule, loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests, z } from '@drobek/modules';

const role = vi.hoisted(() => ({
  user: { id: '', email: 'root@example.com' },
  ws: { id: '', slug: 'acme', name: 'Acme', kind: 'team' },
  effective: 'workspace-admin' as 'workspace-admin' | 'editor' | 'viewer',
  superAdmin: false,
}));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async (_request: Request, slug: string, minRole: string) => {
    if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
    const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as Record<string, number>;
    if (rank[role.effective] < rank[minRole]) throw new Response('Forbidden', { status: 403 });
    return { user: role.user, workspace: role.ws, membershipRole: role.effective, superAdmin: role.superAdmin, effectiveRole: role.effective };
  },
  workspaceNav: () => ({ slug: role.ws.slug }),
}));

const { loader, action } = await import('./routes/workspaces.$slug.modules.server.js');

const vault = defineModule({
  name: 'vault',
  version: '2.0.0',
  availability: 'opt-in',
  skill: { useWhen: 'the app needs the firm vault', markdown: '# vault\n' },
  configSchema: z.object({}),
  configDefaults: {},
});
const plain = defineModule({
  name: 'plain',
  version: '1.0.0',
  skill: { useWhen: 'nothing', markdown: '# plain\n' },
  configSchema: z.object({}),
  configDefaults: {},
});

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

function load() {
  const request = new Request('https://drobek.example/workspaces/acme/modules');
  return loader({ request, params: { slug: 'acme' }, context: {} } as never);
}

function post(body: Record<string, string>) {
  const request = new Request('https://drobek.example/workspaces/acme/modules', { method: 'POST', body: new URLSearchParams(body) });
  return action({ request, params: { slug: 'acme' }, context: {} } as never);
}

function result(res: unknown): { status: number; data: Record<string, unknown> } {
  const d = res as { data: Record<string, unknown>; init: { status?: number } | null };
  return { status: d.init?.status ?? 200, data: d.data };
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'root@example.com' }).returning();
  role.user = { id: u.id, email: u.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  role.ws = { id: w.id, slug: w.slug, name: w.name, kind: 'team' };
  setModuleRuntimeForTests(
    await loadModuleRuntime({
      env: { APPS_DOMAIN: 'apps.example', PUBLIC_APP_URL: 'https://drobek.example', DROBEK_MIGRATE_ON_START: '0' },
      log: noopLogger,
      modules: [plain, vault],
      skillsDir: null,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    })
  );
});

afterAll(async () => {
  setModuleRuntimeForTests(null);
  await pg.close();
});

beforeEach(async () => {
  await db.delete(workspaceModules);
  await db.delete(auditLog);
  role.effective = 'workspace-admin';
  role.superAdmin = false;
});

describe('/workspaces/:slug/modules', () => {
  it('a viewer and an editor read the page (the opt-in state included); the switch answers 403', async () => {
    for (const r of ['viewer', 'editor'] as const) {
      role.effective = r;
      const d = await load();
      expect(d.optIn.canToggle).toBe(false);
      expect(d.optIn.modules.map((m) => [m.name, m.enabled])).toEqual([['vault', false]]);
      expect(d.modules.map((m) => [m.name, m.availability])).toEqual([
        ['plain', 'default'],
        ['vault', 'opt-in'],
      ]);
      expect(result(await post({ intent: 'workspace-module', module: 'vault', enabled: '1' })).status).toBe(403);
    }
    expect(await db.select().from(workspaceModules)).toEqual([]);
  });

  it('who switched a module on is shown to workspace admins only', async () => {
    await db.insert(workspaceModules).values({ workspaceId: role.ws.id, module: 'vault', enabledBy: role.user.id });
    expect((await load()).optIn.modules[0]).toMatchObject({ enabled: true, source: 'dashboard', dashboard: { enabled: true, enabled_by: 'root@example.com' } });
    role.effective = 'editor';
    expect((await load()).optIn.modules[0]).toMatchObject({ enabled: true, source: 'dashboard', dashboard: { enabled: true, enabled_by: null } });
  });

  it('a workspace admin sees the opt-in modules read-only; the switch answers 403 and changes nothing', async () => {
    const d = await load();
    expect(d.optIn.canToggle).toBe(false);
    expect(d.optIn.modules).toEqual([
      expect.objectContaining({ name: 'vault', version: '2.0.0', enabled: false, source: null, dashboard: { enabled: false, enabled_by: null, enabled_at: null } }),
    ]);
    const r = result(await post({ intent: 'workspace-module', module: 'vault', enabled: '1' }));
    expect(r.status).toBe(403);
    expect(await db.select().from(workspaceModules)).toEqual([]);
  });

  it('a super-admin enables and disables it (audited, meta.module)', async () => {
    role.superAdmin = true;
    expect((await load()).optIn.canToggle).toBe(true);
    expect(result(await post({ intent: 'workspace-module', module: 'vault', enabled: '1' })).data).toEqual({
      ok: true,
      module: 'vault',
      enabled: true,
      changed: true,
    });
    const on = (await load()).optIn.modules[0];
    expect(on).toMatchObject({ enabled: true, source: 'dashboard', dashboard: { enabled: true, enabled_by: 'root@example.com' } });
    expect(result(await post({ intent: 'workspace-module', module: 'vault', enabled: '0' })).data).toMatchObject({ enabled: false, changed: true });
    expect((await load()).optIn.modules[0]).toMatchObject({ enabled: false });
    const audits = await db.select({ action: auditLog.action, target: auditLog.target, meta: auditLog.meta, actorKind: auditLog.actorKind }).from(auditLog);
    expect(audits).toEqual([
      { action: 'module.workspace_enable', target: 'vault', meta: { module: 'vault' }, actorKind: 'user' },
      { action: 'module.workspace_disable', target: 'vault', meta: { module: 'vault' }, actorKind: 'user' },
    ]);
  });

  it('a default or unknown module → 404; another intent → 400', async () => {
    role.superAdmin = true;
    expect(result(await post({ intent: 'workspace-module', module: 'plain', enabled: '1' })).status).toBe(404);
    expect(result(await post({ intent: 'workspace-module', module: 'ghost', enabled: '1' })).status).toBe(404);
    expect(result(await post({ intent: 'other' })).status).toBe(400);
  });
});
