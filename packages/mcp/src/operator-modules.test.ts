/**
 * An operator-only module (no skill — here an error reporter) over the MCP
 * tools: it is active on the server, yet create_app / get_app (`skills`,
 * `modules`, the briefing), skill_info (the list, and by name like an unknown
 * module), configure_module and /llms-full.txt never name it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships, users, workspaces } from '@drobek/db';
import { renderLlmsFull, renderLlmsTxt } from '@drobek/agent-dx';
import { ERROR_REPORTER_SLOT, defineErrorReporter, defineModule, loadModuleRuntime, memoryRateLimiter, z, type ModuleRuntime } from '@drobek/modules';
import { noopLogger } from '@drobek/core';
import type { ToolPrincipal } from './context.js';
import { freshDb } from './test/db.js';
import { connect, testDeps } from './test/harness.js';
import { greet } from './test/modules.js';

const sentinel = defineModule({
  name: 'sentinel',
  version: '1.0.0',
  contract: '^1.2',
  configSchema: z.object({}),
  configDefaults: {},
  contributes: { [ERROR_REPORTER_SLOT]: defineErrorReporter({ id: 'sentinel', label: 'Sentinel', report: () => {} }) },
});

let close: () => Promise<void>;
let rt: ModuleRuntime;
let alice: ToolPrincipal;

beforeAll(async () => {
  const t = await freshDb();
  close = () => t.pg.close();
  const [u] = await t.db.insert(users).values({ email: 'alice@example.test' }).returning();
  const [ws] = await t.db.insert(workspaces).values({ kind: 'team', slug: 'firm', name: 'Firm' }).returning();
  await t.db.insert(memberships).values({ userId: u.id, workspaceId: ws.id, role: 'workspace-admin' });
  alice = { userId: u.id, email: u.email, superAdmin: false };
  rt = await loadModuleRuntime({
    env: { APPS_DOMAIN: 'drobek.app', PUBLIC_APP_URL: 'https://dash.drobek.test', DROBEK_MIGRATE_ON_START: '0', DROBEK_MASTER_KEY: '22'.repeat(32) },
    log: noopLogger,
    modules: [greet, sentinel],
    skillsDir: null,
    deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
  });
});
afterAll(async () => close());

describe('an operator-only module', () => {
  it('is active on the server', () => {
    expect(rt.modules.map((m) => m.name)).toEqual(['greet', 'sentinel']);
    expect(rt.summary()[1]).toMatchObject({ name: 'sentinel', operatorOnly: true });
  });

  it('create_app, get_app, the briefing, skill_info and configure_module never name it', async () => {
    const c = await connect(alice, { ...testDeps(), modules: async () => rt });
    try {
      const created = await c.call('create_app', { name: 'Quiet app', workspace: 'firm', template: 'html' });
      expect(created.isError, created.text).toBe(false);
      const appId = (created.body as { app_id: string }).app_id;
      expect((created.body.skills as { name: string }[]).map((s) => s.name)).toEqual(['greet']);
      expect(created.text).not.toContain('sentinel');

      const got = await c.call('get_app', { app_id: appId });
      expect(Object.keys(got.body.modules as Record<string, unknown>)).toEqual(['greet']);
      expect((got.body.skills as { name: string }[]).map((s) => s.name)).toEqual(['greet']);
      expect(String(got.body.briefing)).toContain('`greet`');
      expect(got.text).not.toContain('sentinel');

      const list = await c.call('skill_info', {});
      expect(list.body.skills).toEqual([{ name: 'greet', use_when: 'you want the server to greet the visitor' }]);
      const one = await c.call('skill_info', { name: 'sentinel' });
      expect(one.isError).toBe(true);
      expect(one.body).toMatchObject({ code: 'not_found', available: ['greet'], hint: 'skill_info()' });

      const configure = await c.call('configure_module', { app_id: appId, module: 'sentinel', config: {} });
      expect(configure.isError).toBe(true);
      expect(configure.body).toMatchObject({ code: 'not_found' });
      expect(JSON.stringify((configure.body as { details?: unknown }).details ?? {})).not.toContain('sentinel');
    } finally {
      await c.close();
    }
  });

  it('/llms.txt and /llms-full.txt (with the modules\' error catalogue) never name it', () => {
    expect(rt.errorCatalogue().map((s) => s.module)).not.toContain('sentinel');
    expect(renderLlmsFull({ PUBLIC_APP_URL: 'https://dash.drobek.test' }, rt.errorCatalogue())).not.toContain('sentinel');
    expect(renderLlmsTxt({ PUBLIC_APP_URL: 'https://dash.drobek.test' })).not.toContain('sentinel');
  });
});
