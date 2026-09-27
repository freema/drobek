/**
 * NSO-340 — a duplicated gallery app's module configs: the saved configs
 * (never pending changes or secrets) go through the copy's normal configure
 * path, so a change that needs confirmation waits there; e-mail addresses and
 * the whole proxy config are dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apps, moduleConfigs, moduleSecrets, users, workspaces } from '@drobek/db';
import { noopLogger } from '@drobek/core';
import { z } from 'zod';
import { defineModule } from './contract.js';
import { configForCopy, duplicateModuleConfigs } from './duplicate.js';
import { memoryMailGuard } from './mail-guard.js';
import { loadModuleRuntime, memoryRateLimiter, type ModuleRuntime } from './runtime.js';
import { setModuleSecret } from './secrets.server.js';
import { freshDb, type TestDb } from './test/db.js';
import { echo, quiet } from './test/fixtures.js';

const ENV = {
  APPS_DOMAIN: 'apps.example',
  PUBLIC_APP_URL: 'https://drobek.example',
  PUBLIC_ORIGIN: 'https://drobek.example',
  DROBEK_MASTER_KEY: '11'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const proxy = defineModule<{ upstreams: Record<string, unknown> }>({
  name: 'proxy',
  version: '0.0.1',
  skill: { useWhen: 'you call an upstream in a test', markdown: '# proxy\n' },
  configSchema: z.object({ upstreams: z.record(z.string(), z.unknown()) }),
  configDefaults: { upstreams: {} },
});

let db: TestDb;
let close: () => Promise<void>;
let rt: ModuleRuntime;
let userId: string;
let source: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
let target: { id: string; slug: string; workspaceId: string; workspaceSlug: string };

beforeAll(async () => {
  const fresh = await freshDb();
  db = fresh.db;
  close = () => fresh.pg.close();
  [{ id: userId }] = await db.insert(users).values({ email: 'copier@example.com' }).returning();
  const [w1] = await db.insert(workspaces).values({ kind: 'team', slug: 'author', name: 'Author' }).returning();
  const [w2] = await db.insert(workspaces).values({ kind: 'team', slug: 'copier', name: 'Copier' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: w1.id, slug: 'wall' }).returning();
  const [b] = await db.insert(apps).values({ workspaceId: w2.id, slug: 'wall-copy' }).returning();
  source = { id: a.id, slug: a.slug, workspaceId: w1.id, workspaceSlug: w1.slug };
  target = { id: b.id, slug: b.slug, workspaceId: w2.id, workspaceSlug: w2.slug };
  rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [echo, quiet, proxy],
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
    },
  });
});

afterAll(async () => close());

describe('configForCopy', () => {
  it('drops e-mail addresses, nulls, the proxy config and what ends up empty', () => {
    expect(configForCopy('echo', { greeting: 'hi', notify: ['owner@example.com', 'ops'], contact: 'Mail <a@b.cz>', n: 3 })).toEqual({
      greeting: 'hi',
      notify: ['ops'],
      n: 3,
    });
    expect(configForCopy('echo', { admin: 'a@b.cz', gone: null })).toBeNull();
    expect(configForCopy('proxy', { upstreams: { api: { id: 'x' } } })).toBeNull();
    expect(configForCopy('echo', null)).toBeNull();
  });
});

describe('duplicateModuleConfigs', () => {
  it('applies plain configs, holds confirmable ones for the new owner, never copies secrets or pending changes', async () => {
    await db.insert(moduleConfigs).values([
      { appId: source.id, module: 'echo', config: { greeting: 'yo', access: 'public', notify: ['owner@example.com'] } },
      { appId: source.id, module: 'quiet', config: { on: true }, pending: { patch: { on: false }, changes: ['x'], proposed_at: '2026-01-01T00:00:00Z', proposed_by: userId, confirm_role: 'editor' } },
      { appId: source.id, module: 'proxy', config: { upstreams: { api: { id: 'rec-1' } } } },
      { appId: source.id, module: 'retired', config: { a: 1 } },
    ]);
    await setModuleSecret({ appId: source.id, module: 'echo', name: 'ECHO_TOKEN', value: 'sk-live-NEVER-COPIED-0123456789', env: ENV });

    const out = await duplicateModuleConfigs(rt, { sourceAppId: source.id, target, actorUserId: userId, surface: 'web' });
    expect(out.applied).toEqual(['quiet']);
    expect(out.pending).toEqual([
      { module: 'echo', changes: ['access: anyone can read'], confirm_url: expect.stringContaining('/workspaces/copier/apps/wall-copy') },
    ]);
    expect(out.skipped).toEqual(
      expect.arrayContaining([
        { module: 'proxy', reason: 'not_copied' },
        { module: 'retired', reason: 'not_enabled' },
      ])
    );

    const rows = await db.select().from(moduleConfigs).where(eq(moduleConfigs.appId, target.id));
    const quietRow = rows.find((r) => r.module === 'quiet');
    expect(quietRow).toMatchObject({ config: { on: true }, pending: null });
    const echoRow = rows.find((r) => r.module === 'echo');
    expect((echoRow?.pending as { patch?: unknown } | null)?.patch).toEqual({ greeting: 'yo', access: 'public', notify: [] });
    expect(rows.some((r) => r.module === 'proxy')).toBe(false);
    const secrets = await db.select().from(moduleSecrets).where(eq(moduleSecrets.appId, target.id));
    expect(secrets).toEqual([]);
  });
});
