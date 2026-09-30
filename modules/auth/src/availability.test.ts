/**
 * An opt-in sign-in provider module follows the
 * workspace switch through the REAL module runtime — provider discovery,
 * begin, the dashboard-host callback, complete, the `auth.signedIn` observer
 * and the sessions it made. Two workspaces, the provider module enabled for
 * A only; PGlite (core + auth migrations) and the in-memory FakeRedis.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import { noopLogger } from '@drobek/core';
import { apps, moduleConfigs, setDbForTests, users, workspaceModules, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import {
  cookiePrincipalResolver,
  defineAuthProvider,
  defineModule,
  defineSignInObserver,
  endUserSessionKey,
  loadModuleRuntime,
  memoryMailGuard,
  memoryRateLimiter,
  z,
  type AnyModule,
  type AuthSignInEvent,
  type EndUserCallbackResult,
  type ModuleRuntime,
  type PlatformApp,
  type PlatformRequest,
} from '@drobek/modules';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return { ...actual, getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis> };
});

import auth from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const ENV = {
  APPS_DOMAIN: 'apps.localhost:3041',
  PUBLIC_APP_URL: 'http://localhost:3041',
  DROBEK_MASTER_KEY: 'ab'.repeat(32),
  DROBEK_MIGRATE_ON_START: '0',
};

const challenges = new Map<string, string>();
const calls: string[] = [];
const events: AuthSignInEvent[] = [];

const provider = defineAuthProvider({
  id: 'ssotest',
  label: 'Firm SSO',
  configSchema: z.strictObject({ issuer: z.url() }),
  identityFields: ['issuer'],
  async begin({ config, state, codeChallenge }) {
    calls.push('begin');
    challenges.set(state, codeChallenge);
    return { url: `${config.issuer}/authorize?state=${encodeURIComponent(state)}` };
  },
  async callback({ state, codeVerifier, config }) {
    calls.push('callback');
    if (createHash('sha256').update(codeVerifier).digest('base64url') !== challenges.get(state)) throw new Error('pkce mismatch');
    return { issuer: config.issuer, subject: 'sub-ana', email: 'ana@example.com', emailVerified: true };
  },
});

const sso: AnyModule = defineModule<Record<string, never>>({
  name: 'ssotest',
  version: '1.0.0',
  availability: 'opt-in',
  skill: { useWhen: 'firm SSO (fixture)', markdown: '# ssotest' },
  configSchema: z.object({}),
  configDefaults: {},
  contributes: {
    'auth.provider': provider,
    'auth.signedIn': defineSignInObserver({ id: 'sso-observer', onSignIn: (e) => void events.push(e) }),
  },
});
const MODULES = [auth, sso];
const CONFIG = { allow: { emails: ['ana@example.com'], domains: [], anyone: false }, providers: { emailCode: { enabled: true }, ssotest: { enabled: true, issuer: 'https://sso.example' } } };

let pg: PGlite;
let db: DB;
let rt: ModuleRuntime;
let rootId: string;
let appA: PlatformApp;
let appB: PlatformApp;

const hostOf = (app: PlatformApp) => `${app.slug}--preview.apps.localhost:3041`;

function request(app: PlatformApp, method: string, path: string, opts: { body?: unknown; cookie?: string; query?: string } = {}): PlatformRequest {
  const headers: Record<string, string> = {
    host: hostOf(app),
    ...(method === 'POST' ? { origin: `http://${hostOf(app)}`, 'x-drobek-sdk': '1', 'content-type': 'application/json' } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  };
  const raw = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
  return {
    method,
    path,
    query: opts.query ?? '',
    header: (n) => headers[n.toLowerCase()] ?? null,
    headers: () => headers,
    clientIp: '203.0.113.7',
    readBody: async () => raw,
  };
}

async function call(app: PlatformApp, method: string, path: string, opts: { body?: unknown; cookie?: string; query?: string } = {}) {
  const res = await rt.handle(request(app, method, `/__drobek/v1/auth${path}`, opts), app);
  const text = res.body === null ? '' : String(res.body);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an HTML page */
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function setModule(workspaceId: string, enabled: boolean) {
  await rt.setWorkspaceModule({ workspaceId, module: 'ssotest', enabled, actorUserId: rootId });
}

async function begin(app: PlatformApp) {
  const res = await call(app, 'POST', '/begin', { body: { provider: 'ssotest', return_to: '/' } });
  if (res.status !== 200) return { res, state: '', flow: '' };
  const state = new URL((res.json as { url: string }).url).searchParams.get('state')!;
  return { res, state, flow: res.headers['Set-Cookie'].split(';')[0] };
}

function callback(state: string): Promise<EndUserCallbackResult> {
  return rt.endUserCallback({ provider: 'ssotest', method: 'GET', query: { state, code: 'idp-code' }, body: null, clientIp: '203.0.113.7' });
}

function codeOf(result: EndUserCallbackResult): string {
  expect(result.kind, JSON.stringify(result)).toBe('redirect');
  return new URL((result as { location: string }).location).searchParams.get('code')!;
}

async function signIn(app: PlatformApp): Promise<string> {
  const b = await begin(app);
  const done = await call(app, 'GET', '/complete', { query: `code=${codeOf(await callback(b.state))}`, cookie: b.flow });
  expect(done.status, done.text).toBe(302);
  return done.headers['Set-Cookie'].split(';')[0];
}

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: auth.migrations!.folder as string, migrationsTable: '__drizzle_migrations_mod_auth', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
  setDbForTests(db);
  [{ id: rootId }] = await d.insert(users).values({ email: 'root@example.com' }).returning();
  const [wsA] = await d.insert(workspaces).values({ kind: 'team', slug: 'ws-a', name: 'A' }).returning();
  const [wsB] = await d.insert(workspaces).values({ kind: 'team', slug: 'ws-b', name: 'B' }).returning();
  const [a] = await d.insert(apps).values({ workspaceId: wsA.id, slug: 'board-a' }).returning();
  const [b] = await d.insert(apps).values({ workspaceId: wsB.id, slug: 'board-b' }).returning();
  appA = { id: a.id, slug: a.slug, workspaceId: wsA.id };
  appB = { id: b.id, slug: b.slug, workspaceId: wsB.id };
  await d.insert(moduleConfigs).values([
    { appId: a.id, module: 'auth', config: CONFIG },
    { appId: b.id, module: 'auth', config: CONFIG },
  ]);
  const runtime: { rt: ModuleRuntime | null } = { rt: null };
  rt = await loadModuleRuntime({
    env: ENV,
    log: noopLogger,
    modules: MODULES,
    skillsDir: null,
    deps: {
      db: () => db,
      rateLimit: memoryRateLimiter(),
      principal: cookiePrincipalResolver({ redis: () => fake, secure: false, current: (app, user) => runtime.rt!.currentEndUser(app, user) }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 1000, pauseMinutes: 1 }, noopLogger),
    },
  });
  runtime.rt = rt;
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

beforeEach(async () => {
  fake = new FakeRedis();
  challenges.clear();
  calls.length = 0;
  events.length = 0;
  await db.delete(workspaceModules);
  await setModule(appA.workspaceId, true);
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

describe('an opt-in sign-in provider follows the workspace switch', () => {
  it('provider discovery: listed for the enabled workspace only', async () => {
    expect((await call(appA, 'GET', '/providers')).json).toEqual({ providers: [{ id: 'emailCode', label: 'E-mail code' }, { id: 'ssotest', label: 'Firm SSO' }] });
    expect((await call(appB, 'GET', '/providers')).json).toEqual({ providers: [{ id: 'emailCode', label: 'E-mail code' }] });
  });

  it('A: begin → callback → complete → a session, and the observer runs; B: begin is refused, the provider never runs', async () => {
    const cookie = await signIn(appA);
    expect(calls).toEqual(['begin', 'callback']);
    expect((await call(appA, 'GET', '/me', { cookie })).json).toMatchObject({ user: { email: 'ana@example.com' } });
    await vi.waitFor(() => expect(events.map((e) => [e.app.id, e.provider])).toEqual([[appA.id, 'ssotest']]));

    calls.length = 0;
    const b = await begin(appB);
    expect(b.res.status).toBe(404);
    expect(b.res.json).toMatchObject({ error: 'provider_not_enabled' });
    expect(calls).toEqual([]);
  });

  it('the callback decides by the workspace of the app the state names: disabled after begin → refused, the provider is not called', async () => {
    const b = await begin(appA);
    await setModule(appA.workspaceId, false);
    expect(await callback(b.state)).toMatchObject({ kind: 'page', status: 404 });
    expect(calls).toEqual(['begin']);
  });

  it('disabled between callback and complete → complete refuses, no session, no observer', async () => {
    const b = await begin(appA);
    const code = codeOf(await callback(b.state));
    await setModule(appA.workspaceId, false);
    const res = await call(appA, 'GET', '/complete', { query: `code=${code}`, cookie: b.flow });
    expect(res.status).toBe(403);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });

  it('switching the module off ends its sessions: the principal of every module request, and me', async () => {
    const cookie = await signIn(appA);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    expect(await rt.deps.principal({ app: appA, cookieHeader: cookie })).toMatchObject({ kind: 'user', email: 'ana@example.com' });
    await setModule(appA.workspaceId, false);
    expect(await rt.deps.principal({ app: appA, cookieHeader: cookie })).toEqual({ kind: 'anon' });
    expect(await fake.get(endUserSessionKey(appA.id, token))).toBeNull();
    await setModule(appA.workspaceId, true);
    expect(await rt.deps.principal({ app: appA, cookieHeader: cookie })).toEqual({ kind: 'anon' });

    const again = await signIn(appA);
    expect((await call(appA, 'GET', '/me', { cookie: again })).json).toMatchObject({ user: { email: 'ana@example.com' } });
    await setModule(appA.workspaceId, false);
    expect((await call(appA, 'GET', '/me', { cookie: again })).json).toEqual({ user: null });
  });
});
