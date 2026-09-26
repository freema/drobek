/**
 * The workspace Modules page's loader (NSO-347) with a real ModuleRuntime
 * (test modules; the workspace role gate is stubbed — requireWorkspaceRole
 * has its own tests in @drobek/tenancy): every active module with version,
 * source, contract, availability, requires, slots + contributions, limits
 * with the value in force for THIS workspace, error codes — for a viewer;
 * never a path on disk, never a secret.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@drobek/core';
import { defineModule, loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests, z, type ModuleRuntime } from '@drobek/modules';

const role = vi.hoisted(() => ({
  current: 'viewer' as 'viewer' | 'editor' | 'workspace-admin',
  ws: { id: 'ws_1', slug: 'acme', name: 'Acme', kind: 'team' },
}));

vi.mock('@drobek/tenancy', () => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    requireWorkspaceRole: async (_request: Request, slug: string, min: keyof typeof rank) => {
      if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
      if (rank[role.current] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: { id: 'u_1', email: 'v@example.com' }, workspace: role.ws, membershipRole: role.current, superAdmin: false, effectiveRole: role.current };
    },
    workspaceNav: (access: { workspace: { slug: string; name: string; kind: string }; effectiveRole: string }) => ({
      slug: access.workspace.slug,
      name: access.workspace.name,
      kind: access.workspace.kind,
      role: access.effectiveRole,
      canViewActivity: false,
      canManageUpstreams: false,
    }),
  };
});

const { loader } = await import('./workspaces.$slug.modules.server.js');

const base = { skill: { useWhen: 'x', markdown: '# x' }, configSchema: z.object({}), configDefaults: {} };

const host = defineModule({
  ...base,
  name: 'host',
  version: '1.4.0',
  contract: '^1.1',
  skill: { useWhen: 'you greet people', markdown: '# host' },
  slots: { 'host.greeter': { schema: z.object({ id: z.string(), text: z.string() }), unique: 'id', description: 'a way to greet someone' } },
  limits: [
    { env: 'HOST_GREETINGS_PER_DAY', default: 100, meaning: 'Greetings per app per day' },
    { env: 'HOST_GREETERS_MAX', default: 5, meaning: 'Greeters per app' },
  ],
  errors: [{ code: 'no_greeter', meaning: 'Nobody greets in that language.', fix: 'Use a greeter skill_info lists.' }],
  secrets: [{ name: 'HOST_KEY', description: 'the greeting key', required: true }],
});
const pirate = defineModule({
  ...base,
  name: 'pirate',
  version: '0.9.1',
  requires: ['host'],
  availability: 'opt-in',
  contributes: { 'host.greeter': { id: 'arr', text: 'Ahoy' } },
});
// A module the DROBEK_MODULES_DIR loader found in the operator's directory (its origin; the path must never reach the page).
const company = defineModule({ ...base, name: 'company', version: '3.0.0' });

let rt: ModuleRuntime;

beforeAll(async () => {
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'apps.example', PUBLIC_APP_URL: 'https://drobek.example', HOST_GREETERS_MAX: '7' },
    log: noopLogger,
    modules: [host, pirate, company],
    origins: { company: { source: 'dir', path: '/data/modules/company' } },
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter() },
  });
  // This workspace's plan (the limits provider) raises one limit.
  vi.spyOn(rt, 'workspaceLimits').mockImplementation(async (id): Promise<Record<string, number>> => (id === role.ws.id ? { HOST_GREETINGS_PER_DAY: 1000, HOST_GREETERS_MAX: 7 } : {}));
  setModuleRuntimeForTests(rt);
});

afterAll(() => {
  setModuleRuntimeForTests(null);
});

const load = (slug = 'acme') =>
  loader({ request: new Request(`https://drobek.example/workspaces/${slug}/modules`), params: { slug }, context: {} } as never);

describe('the workspace Modules page (NSO-347)', () => {
  it('a viewer sees every active module: version, source, contract, availability, requires, slots + contributions, limits for the workspace, errors', async () => {
    role.current = 'viewer';
    const d = await load();
    expect(d.nav).toMatchObject({ slug: 'acme', name: 'Acme', role: 'viewer' });
    expect(d.modules.map((m) => m.name)).toEqual(['host', 'pirate', 'company']);
    const [h, p, c] = d.modules;
    expect(h).toMatchObject({
      version: '1.4.0',
      source: 'builtin',
      contract: '^1.1',
      availability: 'default',
      requires: [],
      useWhen: 'you greet people',
      slots: [{ name: 'host.greeter', description: 'a way to greet someone', unique: 'id', contributions: [{ module: 'pirate', key: 'arr' }] }],
      contributes: [],
      limits: [
        { name: 'HOST_GREETINGS_PER_DAY', default: 100, value: 1000, meaning: 'Greetings per app per day' },
        { name: 'HOST_GREETERS_MAX', default: 7, value: 7, meaning: 'Greeters per app' },
      ],
      errors: host.errors,
    });
    expect(p).toMatchObject({ version: '0.9.1', availability: 'opt-in', requires: ['host'], contract: null, contributes: [{ slot: 'host.greeter', host: 'host', key: 'arr' }] });
    expect(c).toMatchObject({ source: 'dir', version: '3.0.0' });
  });

  it('never a secret, never a path on disk; a non-member → 404', async () => {
    const text = JSON.stringify(await load());
    expect(text).not.toContain('HOST_KEY');
    expect(text).not.toContain('the greeting key');
    expect(text).not.toMatch(/node_modules|\/data\/modules|\/app\//);
    await expect(load('other')).rejects.toMatchObject({ status: 404 });
  });

  it('the facts equal what skill_info returns to agents', async () => {
    const d = await load();
    for (const m of d.modules) {
      expect(rt.skillInfo(m.name)).toMatchObject({
        version: m.version,
        source: m.source,
        contract: m.contract,
        availability: m.availability,
        requires: m.requires,
        slots: m.slots,
        contributes: m.contributes,
        errors: m.errors,
      });
    }
  });
});
