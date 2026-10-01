/**
 * The app's Modules tab loader with a real ModuleRuntime (test modules; the
 * role gate, the app lookup, the header and the banners are stubbed — they
 * have their own tests): one row per module an app can use, never an
 * operator-only module (no skill), which apps cannot configure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@drobek/core';
import { ERROR_REPORTER_SLOT, defineErrorReporter, defineModule, loadModuleRuntime, memoryRateLimiter, setModuleRuntimeForTests, z, type ModuleRuntime } from '@drobek/modules';

const ws = vi.hoisted(() => ({ id: 'ws_1', slug: 'acme', name: 'Acme' }));

vi.mock('@drobek/tenancy', () => ({
  requireWorkspaceRole: async () => ({ user: { id: 'u_1', email: 'v@example.com' }, workspace: ws, membershipRole: 'viewer', superAdmin: true, effectiveRole: 'viewer' }),
}));
vi.mock('../apps.server.js', () => ({ loadAppForView: async () => ({ id: 'app_1', slug: 'shop' }) }));
vi.mock('../app-page.server.js', () => ({ appHeaderData: async () => ({}) }));
vi.mock('../pending-banner.server.js', () => ({ loadPendingBanner: async () => ({ count: 0, modules: [], href: null }) }));
vi.mock('../sync-banner.server.js', () => ({ loadSyncBanner: async () => null }));

const { loader } = await import('./workspaces.$slug.apps.$appSlug.modules.server.js');

const greet = defineModule({
  name: 'greet',
  version: '1.0.0',
  skill: { useWhen: 'you greet the visitor', markdown: '# greet\n' },
  configSchema: z.object({ greeting: z.string() }),
  configDefaults: { greeting: 'Hi' },
});
const sentinel = defineModule({
  name: 'sentinel',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: { [ERROR_REPORTER_SLOT]: defineErrorReporter({ id: 'sentinel', label: 'Sentinel', report: () => {} }) },
});

let rt: ModuleRuntime;

beforeAll(async () => {
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'apps.example', PUBLIC_APP_URL: 'https://drobek.example', DROBEK_MIGRATE_ON_START: '0' },
    log: noopLogger,
    modules: [greet, sentinel],
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter() },
  });
  vi.spyOn(rt, 'appModules').mockResolvedValue({ greet: { enabled: true, configured: true, config: { greeting: 'Hi' }, pending: false } });
  setModuleRuntimeForTests(rt);
});

afterAll(() => {
  setModuleRuntimeForTests(null);
});

describe("the app's Modules tab", () => {
  it('lists the modules an app can use — an operator-only module never, even for a super-admin', async () => {
    const d = await loader({ request: new Request('https://drobek.example/workspaces/acme/apps/shop/modules'), params: { slug: 'acme', appSlug: 'shop' }, context: {} } as never);
    expect(rt.modules.map((m) => m.name)).toEqual(['greet', 'sentinel']);
    expect(d.modules).toEqual([
      expect.objectContaining({ name: 'greet', useWhen: 'you greet the visitor', enabled: true, configured: true, pending: [], secretsMissing: [] }),
    ]);
    expect(JSON.stringify(d)).not.toContain('sentinel');
  });
});
