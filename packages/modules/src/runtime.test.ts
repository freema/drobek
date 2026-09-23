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
import { apps, auditLog, moduleConfigs, moduleSecrets, users, workspaces } from '@drobek/db';
import { eq } from 'drizzle-orm';
import { noopLogger } from '@drobek/core';
import { createLimitsProvider } from './limits.js';
import { ModuleError } from './errors.js';
import { ModuleRuntime, loadModuleRuntime, memoryRateLimiter, type PlatformRequest, type RuntimeDeps } from './runtime.js';
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
    expect(mods.quiet).toEqual({ configured: false, config: { on: false }, pending: false });

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
});
