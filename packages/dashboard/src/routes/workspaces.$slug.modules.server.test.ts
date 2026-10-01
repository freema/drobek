/**
 * The workspace Modules page's loader with a real ModuleRuntime
 * (test modules; the workspace role gate is stubbed — requireWorkspaceRole
 * has its own tests in @drobek/tenancy): every active module with version,
 * source, contract, availability, requires, slots + contributions, limits
 * with the value in force for THIS workspace, error codes — for a viewer;
 * never a path on disk, never a secret. An operator-only module (no skill) is
 * listed for a super-admin only, marked `operatorOnly`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@drobek/core';
import { ERROR_REPORTER_SLOT, defineErrorReporter, defineModule, loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests, z, type ModuleRuntime } from '@drobek/modules';

const role = vi.hoisted(() => ({
  current: 'viewer' as 'viewer' | 'editor' | 'workspace-admin',
  superAdmin: false,
  ws: { id: 'ws_1', slug: 'acme', name: 'Acme', kind: 'team' },
}));

vi.mock('@drobek/tenancy', () => {
  const rank = { viewer: 1, editor: 2, 'workspace-admin': 3 } as const;
  return {
    requireWorkspaceRole: async (_request: Request, slug: string, min: keyof typeof rank) => {
      if (slug !== role.ws.slug) throw new Response('Not found', { status: 404 });
      if (rank[role.current] < rank[min]) throw new Response('Forbidden', { status: 403 });
      return { user: { id: 'u_1', email: 'v@example.com' }, workspace: role.ws, membershipRole: role.current, superAdmin: role.superAdmin, effectiveRole: role.current };
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
  slots: {
    'host.greeter': { schema: z.object({ id: z.string(), text: z.string() }), unique: 'id', description: 'a way to greet someone' },
    'host.courier': { schema: z.object({ id: z.string() }), unique: 'id', description: 'where the server sends greetings', operatorOnly: true },
  },
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
// An operator-only module: no skill, only the core-hosted errors.reporter slot.
const sentinel = defineModule({
  name: 'sentinel',
  version: '2.1.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: { [ERROR_REPORTER_SLOT]: defineErrorReporter({ id: 'sentinel', label: 'Sentinel', report: () => {} }) },
});
// An operator-only module contributing to an operator slot of a module every member sees.
const courier = defineModule({ name: 'courier', version: '1.0.0', configSchema: z.object({}), configDefaults: {}, contributes: { 'host.courier': { id: 'pigeon' } } });

let rt: ModuleRuntime;

beforeAll(async () => {
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'apps.example', PUBLIC_APP_URL: 'https://drobek.example', HOST_GREETERS_MAX: '7' },
    log: noopLogger,
    modules: [host, pirate, company, sentinel, courier],
    origins: { company: { source: 'dir', path: '/data/modules/company' } },
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter() },
  });
  // This workspace's plan (the limits provider) raises one limit.
  vi.spyOn(rt, 'workspaceLimits').mockImplementation(async (id): Promise<Record<string, number>> => (id === role.ws.id ? { HOST_GREETINGS_PER_DAY: 1000, HOST_GREETERS_MAX: 7 } : {}));
  // The opt-in state (a DB read in the runtime — its own tests use PGlite); a super-admin switched pirate on.
  vi.spyOn(rt, 'workspaceModules').mockImplementation(async (id) =>
    id === role.ws.id
      ? [
          {
            name: 'pirate',
            version: '0.9.1',
            use_when: 'x',
            enabled: true,
            source: 'dashboard' as const,
            missing_requires: [],
            required_by: [],
            dashboard: { enabled: true, enabled_by: 'root@example.com', enabled_at: '2026-09-26T10:00:00.000Z' },
          },
        ]
      : []
  );
  setModuleRuntimeForTests(rt);
});

afterAll(() => {
  setModuleRuntimeForTests(null);
});

const load = (slug = 'acme') =>
  loader({ request: new Request(`https://drobek.example/workspaces/${slug}/modules`), params: { slug }, context: {} } as never);

describe('the workspace Modules page', () => {
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
      slots: [
        { name: 'host.greeter', description: 'a way to greet someone', unique: 'id', contributions: [{ module: 'pirate', key: 'arr' }] },
        { name: 'host.courier', description: 'where the server sends greetings', unique: 'id', contributions: [] },
      ],
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

  it('each opt-in module carries its state for the workspace; only a super-admin may toggle; who switched it is for workspace admins', async () => {
    role.current = 'viewer';
    let d = await load();
    expect(d.optIn.canToggle).toBe(false);
    expect(d.optIn.modules).toEqual([expect.objectContaining({ name: 'pirate', enabled: true, source: 'dashboard', dashboard: expect.objectContaining({ enabled: true, enabled_by: null }) })]);
    role.current = 'workspace-admin';
    d = await load();
    expect(d.optIn.modules[0].dashboard.enabled_by).toBe('root@example.com');
    role.current = 'viewer';
  });

  it('never a secret, never a path on disk; a non-member → 404', async () => {
    const text = JSON.stringify(await load());
    expect(text).not.toContain('HOST_KEY');
    expect(text).not.toContain('the greeting key');
    expect(text).not.toMatch(/node_modules|\/data\/modules|\/app\//);
    await expect(load('other')).rejects.toMatchObject({ status: 404 });
  });

  it('an operator-only module is listed for a super-admin only, marked operatorOnly — also as a slot contributor', async () => {
    role.current = 'workspace-admin';
    const member = await load();
    expect(member.modules.map((m) => m.name)).toEqual(['host', 'pirate', 'company']);
    expect(member.modules[0].slots.find((s) => s.name === 'host.courier')?.contributions).toEqual([]);
    expect(JSON.stringify(member)).not.toContain('"module":"courier"');
    expect(JSON.stringify(member)).not.toContain('pigeon');
    role.superAdmin = true;
    try {
      const d = await load();
      expect(d.modules.map((m) => m.name)).toEqual(['host', 'pirate', 'company', 'sentinel', 'courier']);
      expect(d.modules[0].slots.find((s) => s.name === 'host.courier')?.contributions).toEqual([{ module: 'courier', key: 'pigeon' }]);
      expect(d.modules[4]).toMatchObject({ operatorOnly: true, contributes: [{ slot: 'host.courier', host: 'host', key: 'pigeon' }] });
      expect(d.modules[3]).toMatchObject({
        operatorOnly: true,
        useWhen: '',
        version: '2.1.0',
        contract: '^1.2',
        contributes: [{ slot: 'errors.reporter', host: 'core', key: 'sentinel' }],
      });
      expect(d.modules[0]).toMatchObject({ operatorOnly: false });
    } finally {
      role.superAdmin = false;
      role.current = 'viewer';
    }
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
