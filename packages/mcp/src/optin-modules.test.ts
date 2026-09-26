/**
 * NSO-346: an opt-in module over the MCP tools — left out of create_app /
 * get_app `skills` and compile hints while it is off for the app's
 * workspace, `get_app.modules.<name>.enabled`, `skill_info` (availability,
 * `enabled_for_workspace` with an app) and configure_module's
 * `module_not_enabled`; all of it flips once the workspace has it enabled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships, users, workspaceModules, workspaces } from '@drobek/db';
import { defineModule, loadModuleRuntime, memoryRateLimiter, z, type ModuleRuntime } from '@drobek/modules';
import { noopLogger } from '@drobek/core';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps } from './test/harness.js';
import { greet } from './test/modules.js';

/** An opt-in firm module; named `files` so a `cloudinary` import points at its skill. */
const vault = defineModule({
  name: 'files',
  version: '0.1.0',
  availability: 'opt-in',
  skill: { useWhen: 'the app needs the firm vault', markdown: '# files\n\nThe firm vault.\n' },
  configSchema: z.object({ shelf: z.string().max(20) }),
  configDefaults: { shelf: 'main' },
});

let db: TestDb;
let close: () => Promise<void>;
let rt: ModuleRuntime;
let wsId: string;
let alice: ToolPrincipal;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [ws] = await db.insert(workspaces).values({ kind: 'team', slug: 'firm', name: 'Firm' }).returning();
  wsId = ws.id;
  await db.insert(memberships).values({ userId: u.id, workspaceId: ws.id, role: 'workspace-admin' });
  alice = { userId: u.id, email: u.email, superAdmin: false };
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '22'.repeat(32) },
    log: noopLogger,
    modules: [greet, vault],
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
  });
});
afterAll(async () => close());

const CLOUDINARY = "import { Cloudinary } from 'cloudinary';\nnew Cloudinary();\n";

describe('an opt-in module off for the workspace, then enabled', () => {
  it('skills, get_app.enabled, skill_info, configure_module and the compile hint follow the switch', async () => {
    const c = await connect(alice, { ...testDeps(), modules: async () => rt });
    try {
      // ── off ──
      const created = await c.call('create_app', { name: 'Vault app', workspace: 'firm', template: 'html' });
      expect(created.isError, created.text).toBe(false);
      const appId = (created.body as { app_id: string }).app_id;
      expect((created.body.skills as { name: string }[]).map((s) => s.name)).toEqual(['greet']);

      let got = await c.call('get_app', { app_id: appId });
      const mods = got.body.modules as Record<string, { enabled: boolean }>;
      expect(mods.greet.enabled).toBe(true);
      expect(mods.files).toMatchObject({ enabled: false, configured: false, config: { shelf: 'main' } });
      expect((got.body.skills as { name: string }[]).map((s) => s.name)).toEqual(['greet']);
      expect(String(got.body.briefing)).not.toContain('firm vault');

      // skill_info without an app: every skill, the opt-in one marked
      const all = await c.call('skill_info', {});
      expect(all.body.skills).toEqual([
        { name: 'greet', use_when: 'you want the server to greet the visitor' },
        { name: 'files', use_when: 'the app needs the firm vault', availability: 'opt-in' },
      ]);
      const inApp = await c.call('skill_info', { app_id: appId });
      expect(inApp.body.skills).toEqual([
        { name: 'greet', use_when: 'you want the server to greet the visitor' },
        { name: 'files', use_when: 'the app needs the firm vault', availability: 'opt-in', enabled_for_workspace: false },
      ]);
      expect((await c.call('skill_info', { name: 'files', app_id: appId })).body).toMatchObject({ availability: 'opt-in', enabled_for_workspace: false });
      expect((await c.call('skill_info', { name: 'files' })).body).not.toHaveProperty('enabled_for_workspace');
      expect((await c.call('skill_info', { name: 'greet', app_id: appId })).body).not.toHaveProperty('enabled_for_workspace');

      const refused = await c.call('configure_module', { app_id: appId, module: 'files', config: { shelf: 'x' } });
      expect(refused.isError).toBe(true);
      expect(refused.body).toMatchObject({ code: 'module_not_enabled', module: 'files', hint: "skill_info('files')" });

      const write = await c.call('write_files', {
        app_id: appId,
        files: [{ path: 'src/main.tsx', content: CLOUDINARY }],
        reasoning: 'cloudinary',
      });
      expect((write.body.compile as { errors: { code: string; hint?: string }[] }).errors[0]).toMatchObject({ code: 'unresolved_import', hint: 'skill_info()' });

      // ── on (the super-admin's switch) ──
      await db.insert(workspaceModules).values({ workspaceId: wsId, module: 'files' });
      got = await c.call('get_app', { app_id: appId });
      expect((got.body.modules as Record<string, { enabled: boolean }>).files.enabled).toBe(true);
      expect((got.body.skills as { name: string }[]).map((s) => s.name)).toEqual(['greet', 'files']);
      expect((got.body.compile_errors as { hint?: string }[])[0].hint).toBe("skill_info('files')");
      expect((await c.call('skill_info', { name: 'files', app_id: appId })).body).toMatchObject({ enabled_for_workspace: true });
      const ok = await c.call('configure_module', { app_id: appId, module: 'files', config: { shelf: 'x' } });
      expect(ok.isError, ok.text).toBe(false);
      expect(ok.body).toMatchObject({ applied: true, config: { shelf: 'x' } });
    } finally {
      await c.close();
    }
  });

  it('skill_info with an app of another workspace answers not_found', async () => {
    const [other] = await db.insert(workspaces).values({ kind: 'team', slug: 'elsewhere', name: 'Elsewhere' }).returning();
    const c = await connect(alice, { ...testDeps(), modules: async () => rt });
    try {
      const r = await c.call('skill_info', { app_id: `nope-${other.id}` });
      expect(r.isError).toBe(true);
      expect(r.body).toMatchObject({ code: 'not_found' });
    } finally {
      await c.close();
    }
  });
});
