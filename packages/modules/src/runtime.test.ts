/**
 * ModuleRuntime against a real (PGlite) database: configure / pending /
 * confirm / reject with audit, secrets never leaking into skill_info or
 * get_app, the SDK endpoints (ETag, immutable ?v=), route dispatch, the limits
 * provider seam end to end.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, auditLog, memberships, moduleConfigs, moduleRequestStats, moduleSecrets, users, workspaces } from '@drobek/db';
import { flushModuleRequests, memoryModuleStatsRedis, queryRequestLog, recordModuleRequest } from '@drobek/insights';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { noopLogger } from '@drobek/core';
import { createLimitsProvider } from './limits.js';
import { ModuleError } from './errors.js';
import { FakeRedis } from '@drobek/auth';
import { z } from 'zod';
import { defineModule, type AnyModule } from './contract.js';
import { cookiePrincipalResolver, createEndUserSession, loadEndUserSession } from './principal.js';
import { ModuleRuntime, loadModuleRuntime, memoryRateLimiter, type PlatformRequest, type RuntimeDeps, type TransportMessage } from './runtime.js';
import { memoryMailGuard, type MailGuard, type MailGuardConfig } from './mail-guard.js';
import { validateModule } from './registry.js';
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
const SECRET_VALUE = 'sk-live-THIS-MUST-NEVER-LEAK-0123456789';

let db: TestDb;
let close: () => Promise<void>;
let pg: PGlite;
let userId: string;
let ws: { id: string; slug: string };
let app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
let rt: ModuleRuntime;
let skillsDir: string;

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function runtime(deps: Partial<RuntimeDeps> = {}): Promise<ModuleRuntime> {
  return loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: [echo, quiet],
    skillsDir,
    deps: {
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
      ...deps,
    },
  });
}

function req(method: string, path: string, init: { query?: string; headers?: Record<string, string>; body?: unknown } = {}): PlatformRequest {
  const headers: Record<string, string> = { host: 'shop--preview.apps.example', ...init.headers };
  const raw = init.body === undefined ? null : Buffer.from(JSON.stringify(init.body));
  return {
    method,
    path,
    query: init.query ?? '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    clientIp: '203.0.113.7',
    readBody: async (limit) => (raw && raw.length > limit ? 'too_large' : raw),
  };
}

const sdkPost = { origin: 'https://shop--preview.apps.example', 'x-drobek-sdk': '1', 'content-type': 'application/json' };

function json(r: { body: unknown }): unknown {
  return JSON.parse(String(r.body));
}

beforeAll(async () => {
  const fresh = await freshDb();
  db = fresh.db;
  pg = fresh.pg;
  close = () => fresh.pg.close();
  [{ id: userId }] = await db.insert(users).values({ email: 'owner@example.com' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme' }).returning();
  ws = w;
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'shop' }).returning();
  app = { id: a.id, slug: a.slug, workspaceId: w.id, workspaceSlug: w.slug };
  skillsDir = mkdtempSync(join(tmpdir(), 'drobek-skills-'));
  for (const [name, text] of Object.entries({
    drobek: '---\nname: drobek\ndescription: connect to drobek\n---\n# drobek\n',
    design: '---\nname: design\ndescription: you want the app to look good\n---\n# design\n\nUse system fonts.\n',
  })) {
    mkdirSync(join(skillsDir, name));
    writeFileSync(join(skillsDir, name, 'SKILL.md'), text);
  }
  rt = await runtime();
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(moduleConfigs);
  await db.delete(moduleSecrets);
  await db.delete(auditLog);
});

describe('skills', () => {
  it('skillList: active modules first, then general skills; never the platform skill', () => {
    expect(rt.skillList()).toMatchInlineSnapshot(`
      [
        {
          "name": "echo",
          "use_when": "you need to echo things back in a test",
        },
        {
          "name": "quiet",
          "use_when": "you want nothing to happen",
        },
        {
          "name": "design",
          "use_when": "you want the app to look good",
        },
      ]
    `);
  });

  it('skillInfo(module): content + sdk + config schema + limits + secret NAMES', () => {
    const info = rt.skillInfo('echo')!;
    expect(info).toMatchSnapshot();
  });

  it('skillInfo(general) and unknown', () => {
    expect(rt.skillInfo('design')).toEqual({
      name: 'design',
      kind: 'general',
      use_when: 'you want the app to look good',
      content: '# design\n\nUse system fonts.\n',
    });
    expect(rt.skillInfo('drobek')).toBeNull();
    expect(rt.skillInfo('nope')).toBeNull();
  });

  it('never returns a secret value or any app config — even with both in the DB', async () => {
    await setModuleSecret({ appId: app.id, module: 'echo', name: 'ECHO_TOKEN', value: SECRET_VALUE, env: ENV });
    await rt.configure({ app, module: 'echo', patch: { greeting: 'app-specific-greeting' }, actorUserId: userId });
    const everything = JSON.stringify([rt.skillList(), rt.skillInfo('echo'), rt.skillInfo('quiet'), rt.skillInfo('design')]);
    expect(everything).not.toContain(SECRET_VALUE);
    expect(everything).not.toContain('app-specific-greeting');
    // get_app's modules view: names + hasSecret only
    const modules = await rt.appModules(app.id);
    expect(JSON.stringify(modules)).not.toContain(SECRET_VALUE);
    expect(modules.echo.secrets).toEqual([
      { name: 'ECHO_TOKEN', hasSecret: true },
      { name: 'ECHO_EXTRA', hasSecret: false },
    ]);
  });

  it("appInfo (NSO-297): get_app's modules.<name>.info and configure_module's info; a failing appInfo is left out", async () => {
    const seen: unknown[] = [];
    const infoMod = defineModule<{ things: string[] }>({
      name: 'infomod',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({ things: z.array(z.string()).default([]) }),
      configDefaults: { things: [] },
      appInfo: async (view) => {
        seen.push(view.app);
        return { count: view.config.things.length, hasSecret: false };
      },
    });
    const broken = defineModule({
      name: 'broken',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({}),
      configDefaults: {},
      appInfo: () => {
        throw new Error('boom');
      },
    });
    const log = logger();
    const r = new ModuleRuntime({ modules: [infoMod, broken], skills: [], sdk: rt.sdk, deps: { ...rt.deps, log } });
    const out = await r.configure({ app, module: 'infomod', patch: { things: ['a', 'b'] }, actorUserId: userId });
    expect(out.info).toEqual({ count: 2, hasSecret: false });
    const hook = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
    const mods = await r.appModules(hook);
    expect(mods.infomod.info).toEqual({ count: 2, hasSecret: false });
    expect(mods.broken.info).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('module appInfo failed', expect.objectContaining({ module: 'broken' }));
    expect(seen).toContainEqual(hook);
    // By id only (no workspace at hand): no info, the rest unchanged.
    expect((await r.appModules(app.id)).infomod.info).toBeUndefined();
  });

  it('compileHint: backend imports → the matching skill when active, else skill_info()', () => {
    expect(rt.compileHint({ code: 'unresolved_import', specifier: 'firebase/firestore' })).toBe('skill_info()');
    expect(rt.compileHint({ code: 'unresolved_import', specifier: 'react' })).toBeUndefined();
    expect(rt.compileHint({ code: 'syntax_error', specifier: 'firebase' })).toBeUndefined();
    const withData = new ModuleRuntime({
      modules: [],
      skills: [{ name: 'data', kind: 'general', useWhen: 'x', markdown: 'x' }],
      sdk: rt.sdk,
      deps: rt.deps,
    });
    expect(withData.compileHint({ code: 'unresolved_import', specifier: 'firebase' })).toBe("skill_info('data')");
    expect(withData.compileHint({ code: 'unresolved_import', specifier: '@supabase/supabase-js' })).toBe("skill_info('data')");
  });
});

describe('configure / confirm / reject', () => {
  it('invalid config → invalid_params with the field path', async () => {
    const err = await rt.configure({ app, module: 'echo', patch: { greeting: '', notify: ['nope'] }, actorUserId: userId }).catch((e) => e);
    expect(err).toBeInstanceOf(ModuleError);
    expect(err.code).toBe('invalid_params');
    expect(err.details).toEqual({
      issues: [
        { path: 'greeting', message: expect.any(String) },
        { path: 'notify[0]', message: expect.any(String) },
      ],
    });
    expect(err.hint).toBe("skill_info('echo')");
    const notObject = await rt.configure({ app, module: 'echo', patch: [1], actorUserId: userId }).catch((e) => e);
    expect(notObject.code).toBe('invalid_params');
  });

  it('unknown module → not_found with the available list', async () => {
    const err = await rt.configure({ app, module: 'nope', patch: {}, actorUserId: userId }).catch((e) => e);
    expect(err.code).toBe('not_found');
    expect(err.details).toEqual({ available: ['echo', 'quiet'] });
  });

  it('refuses a credential-looking value (secrets never travel over MCP)', async () => {
    const err = await rt
      .configure({ app, module: 'echo', patch: { greeting: 'sk-ant-api03-' + 'a'.repeat(90) }, actorUserId: userId })
      .catch((e) => e);
    expect(err.code).toBe('invalid_params');
    expect(err.message).toMatch(/dashboard/);
  });

  it('a safe change applies at once (audit module.configure, agent); secrets_missing lists required secrets', async () => {
    const out = await rt.configure({ app, module: 'echo', patch: { greeting: 'ahoj', loud: true }, actorUserId: userId });
    expect(out).toEqual({
      module: 'echo',
      applied: true,
      config: { greeting: 'ahoj', access: 'user', notify: [], loud: true },
      pending_confirmation: [],
      secrets_missing: ['ECHO_TOKEN'],
    });
    const again = await rt.configure({ app, module: 'echo', patch: { loud: true }, actorUserId: userId });
    expect(again).toMatchObject({ applied: true, unchanged: true });
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => [a.action, a.actorKind, a.target])).toEqual([['module.configure', 'agent', 'shop']]);
    expect(audit[0].meta).toEqual({ module: 'echo', keys: ['greeting', 'loud'] });
  });

  it('a confirmRequired change goes to pending; confirm applies it (audit module.confirm, user)', async () => {
    const out = await rt.configure({ app, module: 'echo', patch: { access: 'public', notify: ['boss@example.com'] }, actorUserId: userId });
    expect(out).toEqual({
      module: 'echo',
      applied: false,
      config: { greeting: 'hi', access: 'user', notify: [], loud: false },
      pending_confirmation: ['access: anyone can read', 'notify: new recipient boss@example.com'],
      confirm_url: 'https://drobek.example/workspaces/acme/apps/shop/modules/echo',
      secrets_missing: ['ECHO_TOKEN'],
    });
    const mods = await rt.appModules(app.id, (m) => `link/${m}`);
    expect(mods.echo).toMatchObject({ pending: true, pending_confirmation: out.pending_confirmation, confirm_url: 'link/echo' });
    expect(mods.quiet).toEqual({ enabled: true, configured: false, config: { on: false }, pending: false });

    // a safe change meanwhile applies and keeps the pending
    const safe = await rt.configure({ app, module: 'echo', patch: { loud: true }, actorUserId: userId });
    expect(safe).toMatchObject({ applied: true, pending_confirmation: out.pending_confirmation, confirm_url: expect.any(String) });

    const confirmed = await rt.confirm({ app, module: 'echo', userId });
    expect(confirmed).toEqual({
      module: 'echo',
      config: { greeting: 'hi', access: 'public', notify: ['boss@example.com'], loud: true },
      confirmed: out.pending_confirmation,
    });
    expect((await rt.appModules(app.id)).echo.pending).toBe(false);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'module.confirm'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'user', actorUserId: userId, target: 'shop', workspaceId: ws.id });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'module.pending'))).map((a) => a.actorKind)).toEqual(['agent']);

    const nothing = await rt.confirm({ app, module: 'echo', userId }).catch((e) => e);
    expect(nothing).toMatchObject({ code: 'conflict', details: { reason: 'nothing_pending' } });
  });

  it('reject drops the pending change and keeps the config (audit module.reject, user)', async () => {
    await rt.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
    const out = await rt.reject({ app, module: 'echo', userId });
    expect(out).toEqual({
      module: 'echo',
      config: { greeting: 'hi', access: 'user', notify: [], loud: false },
      rejected: ['access: anyone can read'],
    });
    expect((await rt.appModules(app.id)).echo.pending).toBe(false);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'module.reject'));
    expect(audit[0]).toMatchObject({ actorKind: 'user', actorUserId: userId });
    expect(await rt.reject({ app, module: 'echo', userId }).catch((e) => e.code)).toBe('conflict');
  });

  it('a newer pending change replaces the older one', async () => {
    await rt.configure({ app, module: 'echo', patch: { notify: ['a@example.com'] }, actorUserId: userId });
    await rt.configure({ app, module: 'echo', patch: { notify: ['b@example.com'] }, actorUserId: userId });
    const done = await rt.confirm({ app, module: 'echo', userId });
    expect(done.config).toMatchObject({ notify: ['b@example.com'] });
  });

  it("confirmRole 'admin' (NSO-322 H3): an editor cannot confirm (403 admin_required) but may reject; an admin confirms and onConfirmed runs in the transaction", async () => {
    const confirmed: unknown[] = [];
    let failOnConfirm = false;
    const vault = defineModule<{ keys: string[]; note: string }>({
      name: 'vault',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# x' },
      configSchema: z.object({ keys: z.array(z.string()), note: z.string() }),
      configDefaults: { keys: [], note: '' },
      confirmRequired: (before, after) => [
        ...after.keys.filter((k) => !before.keys.includes(k)).map((k) => ({ change: `keys: ${k}`, confirmRole: 'admin' as const })),
        ...(after.note !== before.note && after.note === 'loud' ? ['note: loud'] : []),
      ],
      onConfirmed: async (before, after, ctx) => {
        confirmed.push({ before: before.keys, after: after.keys, app: ctx.app.id, userId: ctx.userId, role: ctx.role, hasDb: Boolean(ctx.db) });
        await ctx.audit('granted', { keys: after.keys.length });
        if (failOnConfirm) throw new Error('grant failed');
      },
    });
    const r = await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [vault],
      skillsDir,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    });
    const hookApp = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };

    // A plain editor-level change: no confirm_role anywhere.
    const plain = await r.configure({ app, module: 'vault', patch: { note: 'loud' }, actorUserId: userId });
    expect(plain.applied).toBe(false);
    expect(plain.confirm_role).toBeUndefined();
    expect((await r.moduleView(hookApp, 'vault')).pending).toMatchObject({ confirm_role: 'editor' });
    await r.confirm({ app, module: 'vault', userId }); // role defaults to editor: fine here
    expect(confirmed).toHaveLength(1);

    // Mixed with an admin item → the whole pending change needs an admin.
    const held = await r.configure({ app, module: 'vault', patch: { keys: ['openai'], note: 'quiet' }, actorUserId: userId });
    expect(held).toMatchObject({ applied: false, pending_confirmation: ['keys: openai'], confirm_role: 'admin' });
    expect((await r.appModules(app.id)).vault).toMatchObject({ pending: true, confirm_role: 'admin' });
    expect((await r.moduleView(hookApp, 'vault')).pending).toMatchObject({ confirm_role: 'admin', changes: ['keys: openai'] });
    for (const role of [undefined, 'editor' as const]) {
      const refused = await r.confirm({ app, module: 'vault', userId, role }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ModuleError);
      expect(refused).toMatchObject({ code: 'forbidden', status: 403, details: { reason: 'admin_required', confirm_role: 'admin' } });
    }
    expect((await r.moduleView(hookApp, 'vault')).config).toMatchObject({ keys: [] });

    // A failing onConfirmed rolls the confirmation back.
    failOnConfirm = true;
    await expect(r.confirm({ app, module: 'vault', userId, role: 'admin' })).rejects.toThrow('grant failed');
    expect((await r.moduleView(hookApp, 'vault')).pending).not.toBeNull();
    failOnConfirm = false;

    const done = await r.confirm({ app, module: 'vault', userId, role: 'admin' });
    expect(done).toMatchObject({ config: { keys: ['openai'], note: 'quiet' }, confirmed: ['keys: openai'] });
    expect(confirmed.at(-1)).toEqual({ before: [], after: ['openai'], app: app.id, userId, role: 'admin', hasDb: true });
    // NSO-324: onConfirmed audits in the confirm transaction (actor: the confirming user) — the rolled-back one left no row.
    const granted = await db.select().from(auditLog).where(eq(auditLog.action, 'vault.granted'));
    expect(granted.map((g) => [g.actorUserId, g.actorKind, g.target, g.meta])).toEqual([
      [userId, 'user', app.slug, { keys: 0, module: 'vault' }],
      [userId, 'user', app.slug, { keys: 1, module: 'vault' }],
    ]);

    // Editors may still reject an admin-only change.
    await r.configure({ app, module: 'vault', patch: { keys: ['openai', 'stripe'] }, actorUserId: userId });
    expect((await r.reject({ app, module: 'vault', userId, role: 'editor' })).rejected).toEqual(['keys: stripe']);
  });
});

describe('the dashboard view (M2-02)', () => {
  it('moduleView: schema (input side), stored + effective config, the pending result, secrets as hasSecret only', async () => {
    await setModuleSecret({ appId: app.id, module: 'echo', name: 'ECHO_TOKEN', value: SECRET_VALUE, env: ENV });
    await rt.configure({ app, module: 'echo', patch: { loud: true }, actorUserId: userId });
    await rt.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
    const hookApp = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
    const view = await rt.moduleView(hookApp, 'echo');
    expect(view).toMatchObject({
      name: 'echo',
      version: '1.2.3',
      use_when: 'you need to echo things back in a test',
      stored: { loud: true },
      config: { greeting: 'hi', access: 'user', notify: [], loud: true },
      confirms: true,
      pending: {
        changes: ['access: anyone can read'],
        proposed_by: userId,
        after: { greeting: 'hi', access: 'public', notify: [], loud: true },
      },
      defaults: { greeting: 'hi', access: 'user', notify: [], loud: false },
    });
    expect(view.pending?.invalid).toBeUndefined();
    expect((view.schema as { properties: Record<string, unknown> }).properties.access).toEqual({ type: 'string', enum: ['public', 'user'] });
    expect(view.secrets).toEqual([
      { name: 'ECHO_TOKEN', description: 'upstream token', required: true, hasSecret: true, updated_at: expect.any(String) },
      { name: 'ECHO_EXTRA', description: 'optional', required: false, hasSecret: false, updated_at: null },
    ]);
    expect(JSON.stringify(view)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(view)).not.toContain('ciphertext');
    expect(await rt.pendingSummary(app.id)).toEqual([{ module: 'echo', changes: ['access: anyone can read'] }]);
    expect((await rt.moduleView(hookApp, 'quiet')).pending).toBeNull();
    await expect(rt.moduleView(hookApp, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a web-surface configure is audited as the user', async () => {
    const out = await rt.configure({ app, module: 'echo', patch: { greeting: 'ahoj' }, actorUserId: userId, surface: 'web' });
    expect(out.applied).toBe(true);
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => [a.action, a.actorKind])).toEqual([['module.configure', 'user']]);
  });
});

describe('HTTP on the app hosts', () => {
  it('/__drobek/sdk.js: immutable with the current ?v=, revalidate otherwise, 304 on the ETag', async () => {
    const pinned = await rt.handle(req('GET', '/__drobek/sdk.js', { query: `v=${rt.sdk.hash}` }), app);
    expect(pinned.status).toBe(200);
    expect(pinned.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(pinned.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(pinned.headers.ETag).toBe(`"${rt.sdk.hash}"`);
    const bare = await rt.handle(req('GET', '/__drobek/sdk.js'), app);
    expect(bare.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    const stale = await rt.handle(req('GET', '/__drobek/sdk.js', { query: 'v=0000000000000000' }), app);
    expect(stale.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    const cached = await rt.handle(req('GET', '/__drobek/sdk.js', { headers: { 'if-none-match': `"${rt.sdk.hash}"` } }), app);
    expect(cached.status).toBe(304);
    expect(cached.body).toBeNull();
    const dts = await rt.handle(req('GET', '/__drobek/sdk.d.ts'), app);
    expect(String(dts.body)).toContain('readonly echo: echo.Api;');
    expect((await rt.handle(req('POST', '/__drobek/sdk.js'), app)).status).toBe(405);
  });

  it('dispatches /__drobek/v1/<module>/… with the app config; 404s list what exists', async () => {
    await rt.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
    await rt.confirm({ app, module: 'echo', userId });
    await setModuleSecret({ appId: app.id, module: 'echo', name: 'ECHO_TOKEN', value: SECRET_VALUE, env: ENV });
    const ok = await rt.handle(req('GET', '/__drobek/v1/echo'), app);
    expect(ok.status).toBe(200);
    expect(json(ok)).toEqual({ greeting: 'hi', principal: 'anon', hasToken: true });
    const head = await rt.handle(req('HEAD', '/__drobek/v1/echo'), app);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const unknown = await rt.handle(req('GET', '/__drobek/v1/nope/x'), app);
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toMatchObject({ error: 'not_found', details: { available: ['echo', 'quiet'] }, hint: 'skill_info()' });
    expect((await rt.handle(req('GET', '/__drobek/v1/echo/missing'), app)).status).toBe(404);
    const wrong = await rt.handle(req('PUT', '/__drobek/v1/echo/items/1'), app);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.Allow).toBe('GET, DELETE');
    expect((await rt.handle(req('GET', '/__drobek/other'), app)).status).toBe(404);
  });

  it('the effective config is parsed once per stored content, and a configure is seen at once (NSO-322 H1)', async () => {
    await rt.configure({ app, module: 'echo', patch: { access: 'public', greeting: 'memo-one' }, actorUserId: userId });
    await rt.confirm({ app, module: 'echo', userId });
    const spy = vi.spyOn(echo.configSchema, 'safeParse');
    try {
      for (let i = 0; i < 3; i++) {
        const r = await rt.handle(req('GET', '/__drobek/v1/echo'), app);
        expect(json(r)).toMatchObject({ greeting: 'memo-one' });
      }
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await rt.configure({ app, module: 'echo', patch: { greeting: 'memo-two' }, actorUserId: userId });
      spy.mockClear(); // configure validates the candidate itself
      expect(json(await rt.handle(req('GET', '/__drobek/v1/echo'), app))).toMatchObject({ greeting: 'memo-two' });
      expect(json(await rt.handle(req('GET', '/__drobek/v1/echo'), app))).toMatchObject({ greeting: 'memo-two' });
      expect(spy).toHaveBeenCalledTimes(1);
      // A write the process never saw (another server) is a new stored content, too.
      await db.update(moduleConfigs).set({ config: { access: 'public', greeting: 'memo-three' } }).where(eq(moduleConfigs.appId, app.id));
      expect(json(await rt.handle(req('GET', '/__drobek/v1/echo'), app))).toMatchObject({ greeting: 'memo-three' });
      // Each caller gets its own copy.
      const a = rt.effectiveConfig(echo, { greeting: 'memo-copy' }) as { notify: string[] };
      a.notify.push('mutated@example.com');
      expect(rt.effectiveConfig(echo, { greeting: 'memo-copy' })).toMatchObject({ notify: [] });
    } finally {
      spy.mockRestore();
    }
  });

  it('/__drobek/beacon.js (M1-07): the minified beacon, immutable with its ?v=, 304 on the ETag', async () => {
    expect(rt.sdk.beacon.url).toBe(`/__drobek/beacon.js?v=${rt.sdk.beacon.hash}`);
    const pinned = await rt.handle(req('GET', '/__drobek/beacon.js', { query: `v=${rt.sdk.beacon.hash}` }), app);
    expect(pinned.status).toBe(200);
    expect(pinned.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(pinned.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    const js = String(pinned.body);
    expect(js).toContain('/__drobek/v1/_beacon');
    expect(js).toContain('unhandledrejection');
    expect(js.length).toBeLessThan(8000);
    expect((await rt.handle(req('GET', '/__drobek/beacon.js'), app)).headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
    const etag = pinned.headers.ETag;
    expect((await rt.handle(req('GET', '/__drobek/beacon.js', { headers: { 'if-none-match': etag } }), app)).status).toBe(304);
    expect((await rt.handle(req('POST', '/__drobek/beacon.js'), app)).status).toBe(405);
  });

  it('counts every response of a MATCHED route by status (M1-07); never a 429, an unknown route/method/module or the SDK (NSO-323)', async () => {
    const counted: [string, string, number][] = [];
    const r = await runtime({ requestStats: (appId, module, status) => void counted.push([appId, module, status]) });
    await r.handle(req('GET', '/__drobek/v1/echo/items/7'), app);
    await r.handle(req('GET', '/__drobek/v1/echo/missing'), app);
    await r.handle(req('PUT', '/__drobek/v1/echo/items/1'), app);
    await r.handle(req('GET', '/__drobek/v1/echo/boom'), app);
    await r.handle(req('GET', '/__drobek/v1/echo/teapot'), app);
    await r.handle(req('GET', '/__drobek/v1/nope/x'), app);
    await r.handle(req('GET', '/__drobek/sdk.js'), app);
    await r.handle(req('GET', '/__drobek/beacon.js'), app);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await r.handle(req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'x' } }), app)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(counted).toEqual([
      [app.id, 'echo', 200],
      [app.id, 'echo', 500],
      [app.id, 'echo', 403],
      ...Array.from({ length: 5 }, () => [app.id, 'echo', 200]),
    ]);
    // a failing counter never affects the response
    const broken = await runtime({
      requestStats: () => {
        throw new Error('stats down');
      },
    });
    expect((await broken.handle(req('GET', '/__drobek/v1/echo/items/7'), app)).status).toBe(200);
  });

  it('request stats cost no SQL per response: 1000 × 429 add no statement, 1000 counted responses reach Postgres on the read (NSO-323 M3)', async () => {
    const statements: string[] = [];
    const spies = (['query', 'exec'] as const).map((method) => {
      const original = (pg[method] as (...a: unknown[]) => unknown).bind(pg);
      return vi.spyOn(pg, method).mockImplementation(((sqlText: string, ...rest: unknown[]) => {
        statements.push(sqlText);
        return original(sqlText, ...rest);
      }) as never);
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const redis = memoryModuleStatsRedis();
    const limiter = memoryRateLimiter();
    const counting = await runtime({ rateLimit: limiter, requestStats: (a, m, st) => recordModuleRequest(a, m, st, { redis: () => redis }) });
    const silent = await runtime({ rateLimit: limiter, requestStats: () => undefined });
    const say = () => req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'x' } });
    const today = new Date().toISOString().slice(0, 10);
    await db.delete(moduleRequestStats);
    try {
      // Use up the limit (5 per minute): the first counted response flushes its day once.
      for (let i = 0; i < 5; i++) expect((await counting.handle(say(), app)).status).toBe(200);
      await settle();
      expect(await db.select({ c: moduleRequestStats.count }).from(moduleRequestStats)).toEqual([{ c: 1 }]);

      // The same 1000 throttled requests with and without stats run the same statements.
      statements.length = 0;
      for (let i = 0; i < 1000; i++) expect((await silent.handle(say(), app)).status).toBe(429);
      await settle();
      const baseline = statements.length;
      statements.length = 0;
      for (let i = 0; i < 1000; i++) expect((await counting.handle(say(), app)).status).toBe(429);
      await settle();
      expect(statements.length).toBe(baseline);
      expect(statements.filter((q) => q.includes('module_request_stats'))).toEqual([]);

      // 1000 counted responses inside the flush interval: Redis only, not one stats statement.
      for (let i = 0; i < 1000; i++) expect((await counting.handle(req('GET', '/__drobek/v1/echo/items/7'), app)).status).toBe(200);
      expect((await counting.handle(req('GET', '/__drobek/v1/echo/teapot'), app)).status).toBe(403);
      await settle();
      expect(statements.filter((q) => q.includes('module_request_stats'))).toEqual([]);
      // The read's flush writes the whole day in ONE statement (and proves the spy sees statements).
      await flushModuleRequests(app.id, today, { redis: () => redis });
      expect(statements.filter((q) => q.includes('module_request_stats'))).toHaveLength(1);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    // The read reports the counted classes exactly.
    const days = await queryRequestLog(app.id, null, { flush: false });
    expect(days).toEqual([{ day: today, requests: 0, count_5xx: 0, count_404: 0, modules: { echo: { '2xx': 1005, '3xx': 0, '4xx': 1, '5xx': 0 } } }]);
    // A flush never lowers a stored count (Redis lost its counters → the row keeps its total).
    await flushModuleRequests(app.id, today, { redis: () => memoryModuleStatsRedis() });
    await recordModuleRequest(app.id, 'echo', 200, { redis: () => memoryModuleStatsRedis(), flushEverySec: 0 });
    expect((await queryRequestLog(app.id, null, { flush: false }))[0].modules.echo['2xx']).toBe(1005);
  });

  it('an unexpected handler error → 500 internal_error without internals, logged', async () => {
    const log = logger();
    const r = await runtime({ log });
    const res = await r.handle(req('GET', '/__drobek/v1/echo/boom'), app);
    expect(res.status).toBe(500);
    expect(String(res.body)).not.toContain('kaboom');
    expect(json(res)).toMatchObject({ error: 'internal_error' });
    expect(log.error).toHaveBeenCalled();
  });

  it('the CSRF guard compares Origin with the app host itself', async () => {
    const r = await runtime();
    const ok = await r.handle(req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'x' } }), app);
    expect(ok.status).toBe(200);
    const other = await r.handle(
      req('POST', '/__drobek/v1/echo/say', { headers: { ...sdkPost, origin: 'https://other--preview.apps.example' }, body: { text: 'x' } }),
      app
    );
    expect(other.status).toBe(403);
  });

  it('limits provider: a LOWER provider limit is enforced; provider down → env default + log', async () => {
    const env = { ...ENV, LIMITS_PROVIDER_URL: 'https://plans.example', LIMITS_PROVIDER_SECRET: 'p'.repeat(40) };
    const lower = createLimitsProvider({
      catalogue: echo.limits!,
      env,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ limits: { ECHO_PER_MINUTE: 1 } }) }),
    });
    const r1 = await runtime({ limits: lower });
    const say = () => r1.handle(req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'x' } }), app);
    expect((await say()).status).toBe(200);
    const limited = await say();
    expect(limited.status).toBe(429);
    expect(json(limited)).toMatchObject({ error: 'rate_limited', details: { limit: 1 } });

    const log = logger();
    const down = createLimitsProvider({
      catalogue: echo.limits!,
      env,
      log,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const r2 = await runtime({ limits: down });
    const say2 = () => r2.handle(req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'x' } }), app);
    for (let i = 0; i < 5; i++) expect((await say2()).status).toBe(200); // env default 5
    expect((await say2()).status).toBe(429);
    expect(log.warn).toHaveBeenCalledWith('limits provider unavailable — using the env defaults', expect.anything());
  });

  it('ctx.audit writes an end_user row prefixed with the module', async () => {
    const r = await runtime();
    await r.handle(req('POST', '/__drobek/v1/echo/say', { headers: sdkPost, body: { text: 'abcd' } }), app);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'echo.said'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: 'end_user', actorUserId: null, target: 'shop' });
    expect(rows[0].meta).toEqual({ length: 4, module: 'echo', end_user: 'anon' });
  });

  it("the session owner's endUsers.current decides every module request's principal (config-aware, session ended on null)", async () => {
    const gate = defineModule<{ banned: string[]; admins: string[] }>({
      name: 'gate',
      version: '1.0.0',
      skill: { useWhen: 'x', markdown: '# gate' },
      configSchema: z.object({ banned: z.array(z.string()), admins: z.array(z.string()) }),
      configDefaults: { banned: [], admins: [] },
      endUsers: {
        current: async ({ app: a, user, config }) => {
          expect(a).toEqual({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
          if (config.banned.includes(user.email)) return null;
          return { ...user, role: config.admins.includes(user.email) ? 'admin' : 'user' };
        },
      },
    });
    const fake = new FakeRedis();
    let bound: ModuleRuntime | null = null;
    const r = await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [echo, quiet, gate],
      skillsDir,
      deps: {
        rateLimit: memoryRateLimiter(),
        email: { send: async () => {} },
        mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
        principal: cookiePrincipalResolver({ redis: () => fake, secure: false, current: (a, u) => bound!.currentEndUser(a, u) }),
      },
    });
    bound = r;
    await r.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
    await r.confirm({ app, module: 'echo', userId });
    const token = await createEndUserSession(fake, app.id, { id: 'eu_1', email: 'ana@example.com', role: 'user' });
    const who = async () => json(await r.handle(req('GET', '/__drobek/v1/echo', { headers: { cookie: `drobek_eu=${token}` } }), app));

    expect(await who()).toMatchObject({ principal: 'user:user' });
    await r.configure({ app, module: 'gate', patch: { admins: ['ana@example.com'] }, actorUserId: userId });
    expect(await who()).toMatchObject({ principal: 'user:admin' }); // the next request, no sign-in
    await r.configure({ app, module: 'gate', patch: { banned: ['ana@example.com'] }, actorUserId: userId });
    expect(await who()).toMatchObject({ principal: 'anon' });
    expect(await loadEndUserSession(fake, app.id, token)).toBeNull(); // the session is gone
    await r.configure({ app, module: 'gate', patch: { banned: [] }, actorUserId: userId });
    expect(await who()).toMatchObject({ principal: 'anon' }); // and stays gone
    const hookApp = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
    expect(await r.currentEndUser(hookApp, { id: 'eu_1', email: 'ana@example.com', role: 'user' })).toEqual({
      id: 'eu_1',
      email: 'ana@example.com',
      role: 'admin',
    });
    // Without a session owner, no module honours a session.
    expect(await rt.currentEndUser(hookApp, { id: 'eu_1', email: 'ana@example.com', role: 'user' })).toBeNull();
  });
});

describe('module e-mail (ctx.email.send through the runtime)', () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' } };
  /**
   * A sender module: POST /mail { to } sends to that recipient reference. It
   * owns end-user sessions (`endUsers`), so it is the sign-in provider that
   * may send `{ signInAddress }` (NSO-327).
   */
  const sender = defineModule<{ notify: string[] }>({
    ...base,
    name: 'sender',
    configSchema: z.object({ notify: z.array(z.string()) }),
    configDefaults: { notify: ['team@example.com'] },
    endUsers: { current: async ({ user }) => user },
    routes(r) {
      r.post('/mail', { rule: 'public', body: z.object({ to: z.any() }) }, async (q, ctx) =>
        ctx.email.send({ to: q.body.to, subject: 'Hello\r\nBcc: x@evil.example', text: '<b>hi</b>' })
      );
    },
  });
  /** Any other module: sends like `sender`, but is not the sign-in provider. */
  const intruder = defineModule<Record<string, never>>({
    ...base,
    name: 'intruder',
    configSchema: z.object({}),
    configDefaults: {},
    routes(r) {
      r.post('/mail', { rule: 'public', body: z.object({ to: z.any() }) }, async (q, ctx) =>
        ctx.email.send({ to: q.body.to, subject: 'Your code', text: '123456' })
      );
    },
  });
  /** A mail authority: a per-app daily limit + an envelope. */
  const mailer = defineModule<{ fromName: string }>({
    ...base,
    name: 'mailer',
    configSchema: z.object({ fromName: z.string() }),
    configDefaults: { fromName: 'Shop' },
    limits: [{ env: 'MAILER_PER_DAY', default: 2, meaning: 'mails per app per day' }],
    mail: {
      prepare: async (input) => {
        const r = await input.rateLimit('day', 'all', input.limits.MAILER_PER_DAY, 86_400_000);
        if (!r.ok) throw new ModuleError('limit_exceeded', 'daily', { details: { module: input.module, kind: input.kind } });
        return { fromName: input.config.fromName, replyTo: 'reply@example.com' };
      },
    },
  });

  async function setup(
    modules: AnyModule[],
    opts: {
      /** The mail guard's config (default hourlyMax 1000). */
      guard?: Partial<MailGuardConfig>;
      /** A guard built by the test (shares its counters with it). */
      mailGuard?: (l: ReturnType<typeof logger>) => MailGuard;
      fail?: (m: TransportMessage) => boolean;
      env?: Record<string, string>;
    } = {}
  ) {
    const { fail } = opts;
    const sent: TransportMessage[] = [];
    const l = logger();
    const r = await loadModuleRuntime({
      env: { ...ENV, ...opts.env },
      log: l,
      modules,
      skillsDir: null,
      deps: {
        rateLimit: memoryRateLimiter(),
        principal: async () => ({ kind: 'anon' }),
        email: {
          send: async (m) => {
            if (fail?.(m)) throw new Error(`550 5.1.1 <${m.to}>: Recipient address rejected`);
            sent.push(m);
          },
        },
        mailGuard: opts.mailGuard?.(l) ?? memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 15, ...opts.guard }, l),
      },
    });
    const send = async (to: unknown) =>
      r.handle(req('POST', '/__drobek/v1/sender/mail', { headers: { ...sdkPost }, body: { to } }), app);
    return { r, sent, send, log: l };
  }

  it('the mail authority applies its policy and envelope; one message per address; audit email.send', async () => {
    // The app's owners: editors + workspace-admins of its workspace (not viewers).
    const [ed] = await db.insert(users).values({ email: 'Editor@Example.com' }).returning();
    const [vi] = await db.insert(users).values({ email: 'viewer@example.com' }).returning();
    await db.insert(memberships).values([
      { userId: ed.id, workspaceId: ws.id, role: 'editor' },
      { userId: vi.id, workspaceId: ws.id, role: 'viewer' },
    ]);
    const { send, sent } = await setup([sender, mailer]);
    const res = await send([{ config: 'notify' }, { appOwners: true }]);
    expect(res.status, String(res.body)).toBe(200);
    expect(json(res)).toEqual({ sent: 2 });
    const envelope = { subject: 'Hello Bcc: x@evil.example', text: '<b>hi</b>', fromName: 'Shop', replyTo: 'reply@example.com' };
    expect(sent).toEqual([
      { to: 'team@example.com', ...envelope },
      { to: 'editor@example.com', ...envelope },
    ]);
    await db.delete(memberships).where(eq(memberships.workspaceId, ws.id));
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'email.send'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: 'end_user', target: 'shop', meta: { module: 'sender', kind: 'notification', recipients: 2, end_user: 'anon' } });
    expect(JSON.stringify(rows[0].meta)).not.toContain('team@example.com');
    // The authority's per-app limit (2/day): the third message is refused.
    expect((await send({ config: 'notify' })).status).toBe(200);
    const third = await send({ config: 'notify' });
    expect(third.status).toBe(429);
    expect(json(third)).toMatchObject({ error: 'limit_exceeded', details: { module: 'sender', kind: 'notification' } });
    expect(sent).toHaveLength(3);
  });

  it('{ signInAddress } is reserved for the sign-in provider: another module gets 403 forbidden, nothing is sent or counted (NSO-327)', async () => {
    let guard: MailGuard | undefined;
    const { r, sent, send } = await setup([sender, mailer, intruder], {
      mailGuard: (l) => (guard = memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 15 }, l)),
    });
    const spy = vi.spyOn(guard!, 'admit');
    const res = await r.handle(
      req('POST', '/__drobek/v1/intruder/mail', { headers: { ...sdkPost }, body: { to: { signInAddress: 'victim@example.com' } } }),
      app
    );
    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ error: 'forbidden', details: { reason: 'sign_in_address_not_allowed', module: 'intruder' } });
    expect(sent).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    // Its other recipients resolve as before (anon → { principal } is 401), and the provider still sends codes.
    const note = await r.handle(req('POST', '/__drobek/v1/intruder/mail', { headers: { ...sdkPost }, body: { to: { principal: true } } }), app);
    expect(note.status).toBe(401);
    expect((await send({ signInAddress: 'ana@example.com' })).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(['ana@example.com']);
  });

  it('without a sign-in provider no module may send { signInAddress }', async () => {
    const { r, sent } = await setup([mailer, intruder]);
    const res = await r.handle(req('POST', '/__drobek/v1/intruder/mail', { headers: { ...sdkPost }, body: { to: { signInAddress: 'a@example.com' } } }), app);
    expect(res.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('no recipient resolved → sent 0, nothing counted', async () => {
    const { send, sent } = await setup([sender, mailer]);
    expect(json(await send({ config: 'missing.path' }))).toEqual({ sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it('without a mail authority only sign-in codes go out; notifications are unavailable', async () => {
    const { send, sent } = await setup([sender]);
    const refused = await send({ config: 'notify' });
    expect(refused.status).toBe(503);
    expect(json(refused)).toMatchObject({ error: 'unavailable' });
    const code = await send({ signInAddress: 'ana@example.com' });
    expect(json(code)).toEqual({ sent: 1 });
    expect(sent.map((m) => m.to)).toEqual(['ana@example.com']);
  });

  it('notifications past their hourly budget pause (503 email_paused + the super-admin ALERT line); sign-in codes keep going to their own limit', async () => {
    // G = 4: sign-in codes 2, notifications 2 (one app may use them all) — one
    // of them already sent by another app.
    let guard: MailGuard | undefined;
    const { send, sent, log } = await setup([sender, mailer], {
      mailGuard: (l) => (guard = memoryMailGuard({ hourlyMax: 4, pauseMinutes: 15, appSharePercent: 100 }, l)),
      env: { MAILER_PER_DAY: '100' },
    });
    await guard!.admit(1, { app_id: 'app_other', workspace_id: 'ws_other', module: 'forms', kind: 'notification' });
    expect((await send({ config: 'notify' })).status).toBe(200);
    const over = await send({ config: 'notify' });
    expect(over.status).toBe(503);
    expect(over.headers['Retry-After']).toBe('900');
    expect(json(over)).toMatchObject({ error: 'unavailable', details: { reason: 'email_paused', class: 'notification' } });
    expect(log.error).toHaveBeenCalledWith(
      'ALERT: module e-mail paused — the global hourly cap was reached',
      expect.objectContaining({ event: 'email_global_pause', audience: 'super_admin', module: 'sender', kind: 'notification', class: 'notification', max: 4 })
    );
    // Paused notifications are refused before anything is counted or sent…
    expect((await send({ config: 'notify' })).status).toBe(503);
    // …but sign-in codes still go out, up to THEIR budget (one of the two
    // sent by another app: one app alone stops at its own share first).
    await guard!.admit(1, { app_id: 'app_other', workspace_id: 'ws_other', module: 'auth', kind: 'sign_in' });
    expect((await send({ signInAddress: 'a@example.com' })).status).toBe(200);
    const codesOver = await send({ signInAddress: 'b@example.com' });
    expect(codesOver.status).toBe(503);
    expect(json(codesOver)).toMatchObject({ error: 'unavailable', details: { reason: 'email_paused', class: 'sign_in' } });
    expect(log.error).toHaveBeenLastCalledWith(
      'ALERT: module e-mail paused — the global hourly cap was reached',
      expect.objectContaining({ event: 'email_global_pause', class: 'sign_in', kind: 'sign_in' })
    );
    expect(sent.map((m) => m.to)).toEqual(['team@example.com', 'a@example.com']);
  });

  it('one app past its share of the notification budget: its notifications are refused (email_paused naming the limit); sign-in codes are not', async () => {
    // G = 100: notifications 50, one app 25 % → 12.
    const { send, sent } = await setup([sender, mailer], { guard: { hourlyMax: 100 }, env: { MAILER_PER_DAY: '100' } });
    for (let i = 0; i < 12; i++) expect((await send({ config: 'notify' })).status).toBe(200);
    const over = await send({ config: 'notify' });
    expect(over.status).toBe(503);
    expect(json(over)).toMatchObject({ error: 'unavailable', details: { reason: 'email_paused', limit: 'EMAIL_APP_HOURLY_SHARE', value: 12 } });
    expect(Number(over.headers['Retry-After'])).toBeGreaterThan(3500);
    expect((await send({ signInAddress: 'a@example.com' })).status).toBe(200);
    expect(sent).toHaveLength(13);
  });

  it('an SMTP failure → 503 unavailable, logged without the address; the messages already sent are audited', async () => {
    const { send, sent, log } = await setup([sender, mailer], { fail: (m) => m.to === 'b@example.com' });
    const before = (await db.select().from(auditLog).where(eq(auditLog.action, 'email.send'))).length;
    const res = await send({ config: 'notify' });
    expect(res.status).toBe(200);
    const r = await send({ signInAddress: 'b@example.com' });
    expect(r.status).toBe(503);
    expect(json(r)).toMatchObject({ error: 'unavailable' });
    expect(log.error).toHaveBeenCalledWith('module e-mail failed', expect.objectContaining({ module: 'sender', kind: 'sign_in', sent: 0 }));
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('b@example.com');
    expect(JSON.stringify(log.error.mock.calls)).toContain('<[address]>: Recipient address rejected');
    expect(sent.map((m) => m.to)).toEqual(['team@example.com']);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'email.send'))).length).toBe(before + 1);
  });

  it('pending-change e-mail (M2-02): an agent proposal mails the owners once per app per hour, listing everything that waits', async () => {
    const [ed] = await db.insert(users).values({ email: 'pending-owner@example.com' }).returning();
    await db.insert(memberships).values({ userId: ed.id, workspaceId: ws.id, role: 'editor' });
    try {
      const { r, sent } = await setup([echo, sender, mailer], { env: { MAILER_PER_DAY: '100' } });
      // The owner's own dashboard edit waits too, but mails nobody (they are looking at it).
      const web = await r.configure({ app, module: 'echo', patch: { notify: ['x@example.com'] }, actorUserId: userId, surface: 'web' });
      expect(web.applied).toBe(false);
      expect(sent).toHaveLength(0);
      const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'module.pending'));
      expect(audit.map((a) => a.actorKind)).toEqual(['user']);

      const held = await r.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
      expect(held.applied).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'pending-owner@example.com', subject: '[shop] 1 change awaits your confirmation', fromName: 'Shop' });
      expect(sent[0].text).toContain('Module echo:\n  - access: anyone can read\n  Review: https://drobek.example/workspaces/acme/apps/shop/modules/echo');

      // A second proposal within the hour: no second e-mail (the banner shows it).
      await r.configure({ app, module: 'echo', patch: { notify: ['boss@example.com'] }, actorUserId: userId });
      expect(sent).toHaveLength(1);
      expect(await r.pendingSummary(app.id)).toEqual([{ module: 'echo', changes: ['notify: new recipient boss@example.com'] }]);
      // A safe change never mails.
      await r.configure({ app, module: 'echo', patch: { loud: true }, actorUserId: userId });
      expect(sent).toHaveLength(1);
    } finally {
      await db.delete(memberships).where(eq(memberships.workspaceId, ws.id));
    }
  });

  it('pending-change e-mail: nothing without a mail authority; a refused send never fails configure_module', async () => {
    const [ed] = await db.insert(users).values({ email: 'pending-owner2@example.com' }).returning();
    await db.insert(memberships).values({ userId: ed.id, workspaceId: ws.id, role: 'workspace-admin' });
    try {
      const plain = await setup([echo, sender]);
      expect((await plain.r.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId })).applied).toBe(false);
      expect(plain.sent).toHaveLength(0);
      await plain.r.reject({ app, module: 'echo', userId });

      const failing = await setup([echo, mailer], { fail: () => true });
      const out = await failing.r.configure({ app, module: 'echo', patch: { access: 'public' }, actorUserId: userId });
      expect(out).toMatchObject({ applied: false, pending_confirmation: ['access: anyone can read'] });
      expect(failing.log.warn).toHaveBeenCalledWith('pending-change e-mail not sent', expect.objectContaining({ module: 'echo', error: 'unavailable' }));
      expect(JSON.stringify(failing.log.warn.mock.calls)).not.toContain('pending-owner2@example.com');
    } finally {
      await db.delete(memberships).where(eq(memberships.workspaceId, ws.id));
    }
  });

  it('refuses to load a module whose required module is not active', async () => {
    const needy = defineModule({ ...base, name: 'needy', requires: ['mailer'], configSchema: z.object({}), configDefaults: {} });
    await expect(setup([needy])).rejects.toThrow(/module "needy" requires the module "mailer"/);
  });
});

describe('the records authority (query_data, the dashboard Data tab)', () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' } };

  it('null without a module that stores records', async () => {
    expect(await rt.records(app)).toBeNull();
  });

  it("binds the app's effective config; confirmRequired gets the app and a db", async () => {
    const seen: { config: unknown; app: unknown }[] = [];
    const contexts: unknown[] = [];
    const store = defineModule({
      ...base,
      name: 'store',
      configSchema: z.object({ tables: z.array(z.string()).default([]), open: z.boolean().default(false) }),
      configDefaults: { tables: [], open: false },
      confirmRequired(before, after, context) {
        contexts.push({ app: context.app, hasDb: typeof context.db.select === 'function' });
        return after.open && !before.open ? ['open: anyone'] : [];
      },
      records: {
        collections: async (view) => {
          seen.push({ config: view.config, app: view.app });
          return [];
        },
        query: async () => ({ collection: { name: 'x', rules: {}, schema: null, columns: [], records: 0 }, records: [], total: 0, next_cursor: null }),
        get: async () => null,
        remove: async () => false,
        csv: async function* () {
          yield 'a';
        },
      },
    });
    const r = await loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules: [store],
      skillsDir,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    });
    await r.configure({ app, module: 'store', patch: { tables: ['todos'] }, actorUserId: userId });
    const out = await r.configure({ app, module: 'store', patch: { open: true }, actorUserId: userId });
    expect(out.pending_confirmation).toEqual(['open: anyone']);
    expect(contexts.at(-1)).toEqual({ app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId }, hasDb: true });
    const bound = await r.records({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
    expect(bound?.module).toBe('store');
    await bound!.collections();
    expect(seen).toEqual([{ config: { tables: ['todos'], open: false }, app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId } }]);
    const lines: string[] = [];
    for await (const l of bound!.csv({ collection: 'x' })) lines.push(l);
    expect(lines).toEqual(['a']);
  });
});

describe("the owner's authorities (M2-03): owner config changes, end users, submissions, files", () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' } };
  const hook = () => ({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
  const dropped: string[] = [];

  const store = defineModule({
    ...base,
    name: 'store',
    configSchema: z.object({ tables: z.record(z.string(), z.object({ n: z.number() })).default({}) }),
    configDefaults: { tables: {} },
    records: {
      collections: async () => [],
      query: async () => ({ collection: { name: 'x', rules: {}, schema: null, columns: [], records: 0 }, records: [], total: 0, next_cursor: null }),
      get: async () => null,
      remove: async () => false,
      csv: async function* () {},
      dropCollection: async (view, name) => {
        if (typeof (view.db as { select?: unknown }).select !== 'function') throw new Error('no tx');
        dropped.push(name);
        // `bad` produces a config the schema refuses → the whole change rolls back.
        return { records: 3, configPatch: name === 'bad' ? { tables: { bad: { n: 'x' } } } : { tables: { [name]: null } } };
      },
    },
  });
  const people = defineModule({
    ...base,
    name: 'people',
    configSchema: z.object({ admins: z.array(z.string()).default([]) }),
    configDefaults: { admins: [] },
    endUsers: {
      current: async ({ user }) => user,
      setRole: async (view, id, role) => ({
        user: { id, email: `${id}@x.cz`, role, roleSource: role === 'admin' ? 'config' : null, status: 'active', created_at: '', last_sign_in_at: null },
        configPatch: role === 'admin' ? { admins: [...(view.config as { admins: string[] }).admins, id] } : null,
      }),
    },
  });

  async function load(modules: AnyModule[]) {
    return loadModuleRuntime({
      env: ENV,
      log: noopLogger,
      modules,
      skillsDir,
      deps: { rateLimit: memoryRateLimiter(), principal: async () => ({ kind: 'anon' }), email: { send: async () => {} } },
    });
  }

  it('dropCollection: the patch and the audit land in one transaction; a patch the schema refuses rolls everything back', async () => {
    const r = await load([store]);
    await r.configure({ app, module: 'store', patch: { tables: { todos: { n: 1 }, keep: { n: 2 } } }, actorUserId: userId });
    const bound = (await r.records(hook()))!;
    expect(await bound.dropCollection('todos', userId)).toEqual({ records: 3 });
    const [row] = await db.select().from(moduleConfigs).where(eq(moduleConfigs.appId, app.id));
    expect(row.config).toEqual({ tables: { keep: { n: 2 } } });
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'data.collection_delete'));
    expect(audits.at(-1)).toMatchObject({ actorKind: 'user', actorUserId: userId, target: app.slug, meta: { collection: 'todos', records: 3, module: 'store' } });

    const before = audits.length;
    await expect(bound.dropCollection('bad', userId)).rejects.toMatchObject({ code: 'invalid_params' });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'data.collection_delete'))).length).toBe(before);
    await expect(bound.update('keep', 'id', {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bound.importCsv('keep', 'a')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it("setRole applies the module's config patch (audited end_users.role); missing owner methods → unavailable; no module → null", async () => {
    const r = await load([people]);
    const users = (await r.endUsers(hook()))!;
    expect(await users.setRole('eu_1', 'admin', userId)).toMatchObject({ role: 'admin' });
    const [row] = await db.select().from(moduleConfigs).where(eq(moduleConfigs.module, 'people'));
    expect(row.config).toEqual({ admins: ['eu_1'] });
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, 'end_users.role'))).at(-1);
    expect(audit).toMatchObject({ actorKind: 'user', meta: { end_user: 'eu_1', role: 'admin', module: 'people' } });
    await expect(users.list({})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(users.setDisabled('eu_1', true)).rejects.toMatchObject({ code: 'unavailable' });

    expect(await r.submissions(hook())).toBeNull();
    expect(await r.files(hook())).toBeNull();
    expect(await (await load([store])).endUsers(hook())).toBeNull();
  });

  it('refuses a module whose submissions / files authority is incomplete, and two modules declaring one', async () => {
    const half = defineModule({ ...base, name: 'half', configSchema: z.object({}), configDefaults: {}, files: { list: async () => ({ files: [], next_cursor: null, used_bytes: 0, quota_bytes: 0 }) } as never });
    expect(() => validateModule(half)).toThrow(/files\.open must be a function/);
    const subs = { forms: async () => [], list: async () => ({ submissions: [], total: 0, next_cursor: null }), csv: async function* () {}, remove: async () => false };
    const a = defineModule({ ...base, name: 'formsa', configSchema: z.object({}), configDefaults: {}, submissions: subs });
    const b = defineModule({ ...base, name: 'formsb', configSchema: z.object({}), configDefaults: {}, submissions: subs });
    await expect(load([a, b])).rejects.toThrow(/only one module may store form submissions/);
    const one = await load([a]);
    expect((await one.submissions(hook()))?.module).toBe('formsa');
  });
});

describe('endUserCallback — the IdP callback on the dashboard host (NSO-348)', () => {
  const base = { version: '1.0.0', skill: { useWhen: 'x', markdown: '# x' } };
  const call = (r: ModuleRuntime, query: Record<string, string>) => r.endUserCallback({ provider: 'idp', method: 'GET', query, body: null, clientIp: '203.0.113.7' });
  const idp = defineModule<{ greeting: string }>({
    ...base,
    name: 'idp',
    configSchema: z.object({ greeting: z.string() }),
    configDefaults: { greeting: 'hi' },
    secrets: [{ name: 'IDP_KEY', description: 'the key' }],
    limits: [{ env: 'IDP_CALLBACKS', default: 7, meaning: 'callbacks' }],
    endUsers: {
      current: async ({ user }) => user,
      callback: async ({ query, services }) => {
        if (query.mode === 'throw') throw new Error('boom');
        const view = await services.app(query.app ?? '');
        if (!view) return { kind: 'page', status: 404, title: 'gone', message: 'no such app' };
        if (query.mode === 'undeclared') await view.secrets.get('ECHO_TOKEN');
        await view.audit('sign_in_denied', { reason: 'test' });
        const first = await services.rateLimit('ip', 'k', 1, 60_000);
        const second = await services.rateLimit('ip', 'k', 1, 60_000);
        const key = await view.secrets.get('IDP_KEY');
        return { kind: 'redirect', location: `https://x.example/${view.config.greeting}/${key}/${services.limits().IDP_CALLBACKS}/${first.ok}/${second.ok}` };
      },
    },
  });

  it('without an end-user authority with a callback → a 404 page', async () => {
    expect(await call(rt, {})).toMatchObject({ kind: 'page', status: 404 });
  });

  it('the authority gets a live app (effective config, declared secrets, audit, default limits); deleted / taken-down apps are null; a throw → a generic 500 page', async () => {
    const log = logger();
    const r = await loadModuleRuntime({
      env: ENV,
      log,
      modules: [echo, quiet, idp],
      skillsDir,
      deps: {
        rateLimit: memoryRateLimiter(),
        principal: async () => ({ kind: 'anon' }),
        email: { send: async () => {} },
        mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
        log,
      },
    });
    await r.configure({ app, module: 'idp', patch: { greeting: 'ahoj' }, actorUserId: userId });
    await setModuleSecret({ appId: app.id, module: 'idp', name: 'IDP_KEY', value: 'k-1', env: ENV });
    expect(await call(r, { app: app.id })).toEqual({ kind: 'redirect', location: 'https://x.example/ahoj/k-1/7/true/false' });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'idp.sign_in_denied'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'end_user', actorUserId: null, target: 'shop', meta: { reason: 'test', module: 'idp', end_user: 'anon' } });

    const [gone] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'gone-app', deletedAt: new Date() }).returning();
    const [locked] = await db.insert(apps).values({ workspaceId: ws.id, slug: 'locked-app', lockedReason: 'abuse' }).returning();
    expect(await call(r, { app: gone.id })).toMatchObject({ kind: 'page', status: 404 });
    expect(await call(r, { app: locked.id })).toMatchObject({ kind: 'page', status: 404 });
    expect(await call(r, { app: 'x'.repeat(65) })).toMatchObject({ kind: 'page', status: 404 });

    // another module's secret is out of reach; a throw never leaks its message
    const undeclared = await call(r, { app: app.id, mode: 'undeclared' });
    expect(undeclared).toMatchObject({ kind: 'page', status: 500, title: 'Sign-in failed' });
    const thrown = await call(r, { mode: 'throw' });
    expect(thrown).toMatchObject({ kind: 'page', status: 500 });
    expect(JSON.stringify(thrown)).not.toContain('boom');
    expect(log.error).toHaveBeenCalledWith('end-user sign-in callback failed', expect.objectContaining({ module: 'idp' }));
  });
});
