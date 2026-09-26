/**
 * Sign-in providers (NSO-348) end to end, without a network: a fixture
 * module `authtest` contributes an `auth.provider` (a fake IdP that checks
 * the PKCE verifier) and an `auth.signedIn` observer. The flow runs through
 * the real routes (begin, complete) and the real `endUsers.callback`, with
 * PGlite (core + auth migrations) and the in-memory FakeRedis.
 */
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import { apps, memberships, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import {
  checkModuleSet,
  collectContributions,
  defineAuthProvider,
  defineModule,
  defineSignInObserver,
  z,
  type AuthIdentity,
  type AuthSignInEvent,
  type OwnerView,
} from '@drobek/modules';
import { createModuleTestContext, type ModuleTestContext } from '@drobek/modules/testing';
import type { Logger } from '@drobek/core';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return { ...actual, getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis> };
});

import auth, { type AuthConfig } from './index.js';
import { COMPLETE_PATH, handoffKey, stateKey } from './flow.js';
import { notifySignedIn, providerSecrets } from './providers.js';
import { authUsers } from './schema.js';
import { providerSignIn } from './users.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const HOST = 'team-board--preview.apps.localhost:3041';
const PROD_HOST = 'team-board.apps.localhost:3041';
const MASTER_KEY = 'ab'.repeat(32);

// ── the fixture module: a fake IdP ───────────────────────────────────────────

const newId = () => `eu_${randomBytes(12).toString('hex')}`;
const sha256url = (v: string) => createHash('sha256').update(v).digest('base64url');

/** state → the PKCE challenge begin() got (what a real IdP keeps). */
const challenges = new Map<string, string>();
let identity: AuthIdentity;
let beginFails = false;
let lastState = '';
const seenSecrets: (string | null)[] = [];

const testProvider = defineAuthProvider({
  id: 'authtest',
  label: 'Test IdP',
  configSchema: z.strictObject({ issuer: z.url(), clientId: z.string().min(1), prompt: z.string().optional() }),
  identityFields: ['issuer', 'clientId'],
  secrets: [{ name: 'AUTHTEST_CLIENT_SECRET', description: 'The client secret at the test IdP.', env: 'AUTH_AUTHTEST_CLIENT_SECRET' }],
  async begin({ config, state, codeChallenge, codeChallengeMethod, redirectUri, secrets }) {
    lastState = state;
    if (beginFails) throw new Error('idp down: token=very-secret');
    seenSecrets.push(await secrets.get('AUTHTEST_CLIENT_SECRET'));
    expect(codeChallengeMethod).toBe('S256');
    challenges.set(state, codeChallenge);
    const u = new URL(`${config.issuer}/authorize`);
    u.searchParams.set('state', state);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('client_id', config.clientId);
    return { url: u.toString() };
  },
  async callback({ query, state, codeVerifier }) {
    const challenge = challenges.get(state);
    challenges.delete(state);
    if (!challenge || sha256url(codeVerifier) !== challenge) throw new Error('pkce mismatch');
    if (query.code !== 'idp-code') throw new Error('bad code');
    return identity;
  },
});

const otherProvider = defineAuthProvider({
  id: 'authtwo',
  label: 'Other IdP',
  configSchema: z.strictObject({}),
  async begin() {
    return { url: 'https://two.example/authorize' };
  },
  async callback() {
    return identity;
  },
});

const events: AuthSignInEvent[] = [];
let observerThrows = false;
const observer = defineSignInObserver({
  id: 'crm-sync',
  async onSignIn(event) {
    if (observerThrows) throw new Error(`crm down for ${event.user.email}`);
    events.push(event);
  },
});
const second = defineSignInObserver({
  id: 'audit-copy',
  async onSignIn(event) {
    events.push({ ...event, provider: `copy:${event.provider}` });
  },
});

const fixtureBase = { version: '1.0.0', skill: { useWhen: 'a test sign-in provider (fixture)', markdown: '# fixture' }, configSchema: z.object({}), configDefaults: {} };
const fixture = defineModule<Record<string, never>>({
  ...fixtureBase,
  name: 'authtest',
  contributes: { 'auth.provider': testProvider, 'auth.signedIn': observer },
});
const fixture2 = defineModule<Record<string, never>>({
  ...fixtureBase,
  name: 'authtwo',
  contributes: { 'auth.provider': otherProvider, 'auth.signedIn': second },
});

const slots = collectContributions([auth, fixture, fixture2]);
const CONTRIBUTIONS = Object.fromEntries([...slots].map(([name, list]) => [name, list.map((c) => c.value)]));

// ── DB ───────────────────────────────────────────────────────────────────────

let pg: PGlite;
let db: DB;
let appId: string;
let otherAppId: string;
let workspaceId: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: auth.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_auth', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'prov-ws', name: 'Prov' }).returning();
  workspaceId = ws.id;
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'team-board', name: 'Team board' }).returning();
  const [other] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'other-app', name: 'Other' }).returning();
  appId = app.id;
  otherAppId = other.id;
  const [editor] = await d.insert(users).values({ email: 'builder@example.com' }).returning();
  await d.insert(memberships).values([{ userId: editor.id, workspaceId: ws.id, role: 'editor' }]);
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  fake = new FakeRedis();
  await db.delete(authUsers);
  challenges.clear();
  events.length = 0;
  seenSecrets.length = 0;
  beginFails = false;
  observerThrows = false;
  identity = { subject: 'sub-ana', email: 'Ana@Example.com', emailVerified: true, name: 'Ana' };
  vi.unstubAllEnvs();
  vi.stubEnv('DROBEK_MASTER_KEY', MASTER_KEY);
  vi.stubEnv('APPS_DOMAIN', 'apps.localhost:3041');
  vi.stubEnv('PUBLIC_APP_URL', 'http://localhost:3041');
});

const ISSUER = { issuer: 'https://idp.example', clientId: 'drobek-test' };
const ON = { allow: { emails: ['ana@example.com'], domains: ['firma.cz'], anyone: false }, adminEmails: ['boss@example.com'], providers: { emailCode: { enabled: true }, authtest: { enabled: true, ...ISSUER } } };

function capture(): Logger & { lines: { level: string; message: string; meta?: Record<string, unknown> }[] } {
  const lines: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, meta?: Record<string, unknown>) => void lines.push({ level, message, meta });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function ctx(opts: { config?: Record<string, unknown>; limits?: Record<string, number>; appId?: string; slug?: string; log?: Logger; secrets?: Record<string, string> } = {}): ModuleTestContext {
  return createModuleTestContext(auth, {
    db,
    app: { id: opts.appId ?? appId, slug: opts.slug ?? 'team-board', workspaceId },
    config: opts.config ?? ON,
    limits: opts.limits,
    origin: `http://${HOST}`,
    contributions: CONTRIBUTIONS,
    log: opts.log,
    secrets: opts.secrets,
  });
}

function cookieOf(res: { headers: Record<string, string> }): string {
  const set = res.headers['Set-Cookie'];
  expect(set, 'Set-Cookie').toBeTruthy();
  return set.split(';')[0];
}

async function begin(t: ModuleTestContext, returnTo: string | null = '/board?tab=2#top', host = HOST) {
  const res = await t.request('POST', '/begin', { body: { provider: 'authtest', ...(returnTo === null ? {} : { return_to: returnTo }) }, headers: { host } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const url = new URL((res.body as { url: string }).url);
  return { url, state: url.searchParams.get('state')!, flow: cookieOf(res), setCookie: res.headers['Set-Cookie'] };
}

async function callback(t: ModuleTestContext, state: string, query: Record<string, string> = {}) {
  return t.endUserCallback({ provider: 'authtest', query: { state, code: 'idp-code', ...query } });
}

function codeOf(result: Awaited<ReturnType<ModuleTestContext['endUserCallback']>>): string {
  expect(result.kind, JSON.stringify(result)).toBe('redirect');
  const loc = new URL((result as { location: string }).location);
  expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(`http://${HOST}${COMPLETE_PATH}`);
  return loc.searchParams.get('code')!;
}

async function complete(t: ModuleTestContext, code: string, flow: string | null, host = HOST) {
  return t.request('GET', '/complete', { query: { code }, headers: { host, ...(flow ? { cookie: flow } : {}) } });
}

/** begin → IdP → callback → complete; the session cookie. */
async function signInWithProvider(t: ModuleTestContext): Promise<string> {
  const b = await begin(t);
  const res = await complete(t, codeOf(await callback(t, b.state)), b.flow);
  expect(res.status, JSON.stringify(res.body)).toBe(302);
  return cookieOf(res);
}

async function me(t: ModuleTestContext, cookie: string) {
  const res = await t.request('GET', '/me', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (res.body as { user: { id: string; email: string; role: string } | null }).user;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('auth providers — slots, config, confirmations', () => {
  it('the registry composes auth from the contributions: providers.<id> in the schema, provider secrets declared', () => {
    const [composed] = checkModuleSet([auth, fixture, fixture2], {});
    expect(composed.name).toBe('auth');
    expect(composed.configDefaults).toMatchObject({ providers: { emailCode: { enabled: true }, authtest: { enabled: false }, authtwo: { enabled: false } } });
    expect(composed.secrets!.map((s) => s.name)).toEqual(['AUTHTEST_CLIENT_SECRET']);
    expect(composed.configSchema.safeParse(ON).success).toBe(true);
    // a provider this server does not run is an unknown key
    expect(composed.configSchema.safeParse({ ...ON, providers: { emailCode: { enabled: true }, saml: { enabled: true } } }).success).toBe(false);
  });

  it('a disabled provider may be half-configured; enabling it validates its whole schema', () => {
    const t = ctx();
    const s = t.module.configSchema;
    expect(s.safeParse({ ...ON, providers: { emailCode: { enabled: true }, authtest: { enabled: false, issuer: 'https://x.example' } } }).success).toBe(true);
    const bad = s.safeParse({ ...ON, providers: { emailCode: { enabled: true }, authtest: { enabled: true, issuer: 'https://x.example' } } });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.'))).toContain('providers.authtest.clientId');
  });

  it('turning the e-mail code off with no provider on → invalid (path providers.emailCode.enabled)', () => {
    const s = ctx().module.configSchema;
    const r = s.safeParse({ ...ON, providers: { emailCode: { enabled: false } } });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(['providers.emailCode.enabled']);
    expect(s.safeParse({ ...ON, providers: { emailCode: { enabled: false }, authtest: { enabled: true, ...ISSUER } } }).success).toBe(true);
  });

  it('confirmRequired: enabling a provider and changing its identity fields wait; turning methods off does not', async () => {
    const t = ctx();
    const off = { providers: { authtest: { enabled: false, ...ISSUER } } };
    const on = { providers: { authtest: { enabled: true, ...ISSUER } } };
    expect(await t.confirm(off, on)).toEqual([
      'providers.authtest.enabled: false → true (people the allowlist admits can sign in with Test IdP — issuer "https://idp.example", clientId "drobek-test")',
    ]);
    expect(await t.confirm(on, { providers: { authtest: { enabled: true, ...ISSUER, issuer: 'https://evil.example' } } })).toEqual([
      'providers.authtest.issuer: "https://idp.example" → "https://evil.example" (changes whose Test IdP accounts can sign in)',
    ]);
    // a non-identity field, turning a provider off, turning the e-mail code off: no confirmation
    expect(await t.confirm(on, { providers: { authtest: { enabled: true, ...ISSUER, prompt: 'login' } } })).toEqual([]);
    expect(await t.confirm(on, off)).toEqual([]);
    expect(await t.confirm(on, { providers: { emailCode: { enabled: false }, authtest: { enabled: true, ...ISSUER } } })).toEqual([]);
    // identity fields changed while disabled: nothing yet (enabling will list them)
    expect(await t.confirm(off, { providers: { authtest: { enabled: false, ...ISSUER, clientId: 'x' } } })).toEqual([]);
  });

  it('salvage: a stored provider this server no longer runs is dropped, a broken one turned off, never the e-mail code switched on', () => {
    const salvage = ctx().module.salvageConfig!;
    const r = salvage({ ...ON, providers: { emailCode: { enabled: false }, saml: { enabled: true }, authtest: { enabled: true, issuer: 'nope' } } })!;
    expect(r.config.providers).toEqual({ emailCode: { enabled: false }, authtest: { enabled: false } });
    expect(r.issues.join('\n')).toMatch(/providers\.saml: .*dropped/);
    expect(r.issues.join('\n')).toMatch(/providers\.authtest: .*turned off/);
    expect(r.issues.join('\n')).toMatch(/no sign-in method is on/);
  });

  it('GET /providers lists the methods that are on (e-mail code first, public)', async () => {
    const res = await ctx().request('GET', '/providers');
    expect(res.body).toEqual({ providers: [{ id: 'emailCode', label: 'E-mail code' }, { id: 'authtest', label: 'Test IdP' }] });
    const only = await ctx({ config: { providers: { emailCode: { enabled: false }, authtwo: { enabled: true } } } }).request('GET', '/providers');
    expect(only.body).toEqual({ providers: [{ id: 'authtwo', label: 'Other IdP' }] });
  });

  it('the e-mail code turned off → send-code / verify answer provider_not_enabled', async () => {
    const t = ctx({ config: { providers: { emailCode: { enabled: false }, authtest: { enabled: true, ...ISSUER } } } });
    expect(await t.request('POST', '/send-code', { body: { email: 'ana@example.com' } })).toMatchObject({ status: 404, body: { error: 'provider_not_enabled' } });
    expect(await t.request('POST', '/verify', { body: { email: 'ana@example.com', code: '123456' } })).toMatchObject({ status: 404, body: { error: 'provider_not_enabled' } });
    expect(t.emails).toHaveLength(0);
  });
});

describe('auth providers — the full flow', () => {
  it('begin → IdP → callback (dashboard host) → handoff → complete → a session on the app host', async () => {
    const t = ctx({ secrets: { AUTHTEST_CLIENT_SECRET: 's3cret' } });
    const b = await begin(t);
    // begin: the IdP URL, a signed state, the ONE callback URL, a flow cookie scoped to complete
    expect(b.url.origin).toBe('https://idp.example');
    expect(b.url.searchParams.get('redirect_uri')).toBe('http://localhost:3041/__drobek/auth/callback/authtest');
    expect(b.state).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(b.setCookie).toMatch(/^drobek_eu_flow=[A-Za-z0-9_-]{43}; Path=\/__drobek\/v1\/auth\/complete; HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(b.setCookie).not.toMatch(/Domain=/i);
    expect(seenSecrets).toEqual(['s3cret']);
    // the state record never holds the flow token itself
    const stored = await fake.get(stateKey(b.state.split('.')[0]));
    expect(stored).not.toContain(b.flow.split('=')[1]);

    const result = await callback(t, b.state);
    const code = codeOf(result);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await fake.ttl(handoffKey(code))).toBeLessThanOrEqual(60);

    const res = await complete(t, code, b.flow);
    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe('/board?tab=2#top');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['Set-Cookie']).toMatch(/^drobek_eu=/);
    expect(res.headers['Set-Cookie']).not.toMatch(/Domain=/i);

    const user = await me(t, cookieOf(res));
    expect(user).toMatchObject({ email: 'ana@example.com', role: 'user' });
    const [row] = await db.select().from(authUsers);
    expect(row).toMatchObject({ email: 'ana@example.com', provider: 'authtest', subject: 'sub-ana' });
    expect(t.audits).toContainEqual({ action: 'auth.sign_in', meta: { user_id: row.id, role: 'user', new_user: true, provider: 'authtest' } });

    await vi.waitFor(() => expect(events).toHaveLength(2));
    const own = events.find((e) => e.provider === 'authtest')!;
    expect(own).toMatchObject({ isNew: true, user: { id: row.id, email: 'ana@example.com', name: 'Ana' }, app: { id: appId } });
    expect(events.map((e) => e.provider).sort()).toEqual(['authtest', 'copy:authtest']);
  });

  it('return_to defaults to / ; the secret falls back to the declared AUTH_<ID>_ env var', async () => {
    vi.stubEnv('AUTH_AUTHTEST_CLIENT_SECRET', 'from-env');
    const t = ctx();
    const b = await begin(t, null);
    expect(seenSecrets).toEqual(['from-env']);
    const res = await complete(t, codeOf(await callback(t, b.state)), b.flow);
    expect(res.headers.Location).toBe('/');
  });

  it('a workspace editor signs in as admin; adminEmails → admin', async () => {
    identity = { subject: 'sub-b', email: 'builder@example.com', emailVerified: true };
    const t = ctx();
    expect(await me(t, await signInWithProvider(t))).toMatchObject({ role: 'admin' });
  });

  it('the IdP identity again → the same user; the address follows the IdP', async () => {
    const t = ctx();
    const first = await me(t, await signInWithProvider(t));
    identity = { ...identity, email: 'eva@firma.cz' };
    const again = await me(t, await signInWithProvider(t));
    expect(again!.id).toBe(first!.id);
    expect(again!.email).toBe('eva@firma.cz');
    expect(await db.select().from(authUsers)).toHaveLength(1);
  });

  it('a signedIn observer that throws is logged by name and never blocks the sign-in', async () => {
    observerThrows = true;
    const log = capture();
    const t = ctx({ log });
    const cookie = await signInWithProvider(t);
    expect(await me(t, cookie)).toMatchObject({ email: 'ana@example.com' });
    await vi.waitFor(() => expect(log.lines.some((l) => l.message === 'auth: sign-in observer failed')).toBe(true));
    const line = log.lines.find((l) => l.message === 'auth: sign-in observer failed')!;
    expect(line.meta).toMatchObject({ observer: 'crm-sync', error: 'Error' });
    expect(JSON.stringify(log.lines)).not.toContain('ana@example.com');
    // the other observer still ran
    await vi.waitFor(() => expect(events.map((e) => e.provider)).toEqual(['copy:authtest']));
  });

  it('notifySignedIn cuts a slow observer off and still resolves', async () => {
    const log = capture();
    const slow = defineSignInObserver({ id: 'slow', onSignIn: () => new Promise(() => undefined) });
    await notifySignedIn([slow], { app: { id: 'a', slug: 's', workspaceId: 'w' }, user: { id: 'u', email: 'e@x.cz', role: 'user' }, provider: 'email', isNew: false, db, log }, log, 20);
    expect(log.lines).toContainEqual(expect.objectContaining({ message: 'auth: sign-in observer failed', meta: expect.objectContaining({ observer: 'slow', error: 'TimeoutError' }) }));
  });

  it('the e-mail code sign-in tells the observers too (provider email)', async () => {
    const t = ctx();
    const sent = await t.request('POST', '/send-code', { body: { email: 'ana@example.com' }, headers: { host: HOST } });
    expect(sent.status).toBe(200);
    const code = /\b(\d{6})\b/.exec(t.emails.at(-1)!.subject)![1];
    const res = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code } });
    expect(res.status).toBe(200);
    expect(t.audits.at(-1)).toMatchObject({ action: 'auth.sign_in', meta: { provider: 'email' } });
    await vi.waitFor(() => expect(events.map((e) => e.provider).sort()).toEqual(['copy:email', 'email']));
  });
});

describe('auth providers — refusals', () => {
  it('begin: a provider that is not enabled / not installed → 404 provider_not_enabled', async () => {
    const t = ctx({ config: { providers: { authtest: { enabled: false, ...ISSUER } } } });
    expect(await t.request('POST', '/begin', { body: { provider: 'authtest' }, headers: { host: HOST } })).toMatchObject({ status: 404, body: { error: 'provider_not_enabled' } });
    expect(await ctx().request('POST', '/begin', { body: { provider: 'saml' }, headers: { host: HOST } })).toMatchObject({ status: 404, body: { error: 'provider_not_enabled' } });
    expect(await ctx().request('POST', '/begin', { body: { provider: 'email' }, headers: { host: HOST } })).toMatchObject({ status: 404 });
    expect(await ctx().request('POST', '/begin', { body: { provider: 'emailCode' }, headers: { host: HOST } })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('begin: open-redirect return_to values are refused', async () => {
    const t = ctx();
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', '\\\\evil.example', 'evil', '/ok\r\nSet-Cookie: x=1', '/\tevil', 'javascript:alert(1)', '']) {
      const res = await t.request('POST', '/begin', { body: { provider: 'authtest', return_to: bad }, headers: { host: HOST } });
      expect(res, JSON.stringify(bad)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(challenges.size).toBe(0);
  });

  it('begin: without DROBEK_MASTER_KEY → 503 unavailable (fail closed)', async () => {
    vi.stubEnv('DROBEK_MASTER_KEY', '');
    const res = await ctx().request('POST', '/begin', { body: { provider: 'authtest' }, headers: { host: HOST } });
    expect(res).toMatchObject({ status: 503, body: { error: 'unavailable' } });
  });

  it('begin: the provider failing → 502 provider_error, the state is dropped, the error message is not logged', async () => {
    beginFails = true;
    const log = capture();
    const res = await ctx({ log }).request('POST', '/begin', { body: { provider: 'authtest' }, headers: { host: HOST } });
    expect(res).toMatchObject({ status: 502, body: { error: 'provider_error' } });
    expect(lastState).toMatch(/\./);
    expect(await fake.get(stateKey(lastState.split('.')[0]))).toBeNull();
    expect(JSON.stringify(log.lines)).not.toContain('very-secret');
  });

  it('begin: needs the SDK header (CSRF) like every mutating route', async () => {
    const res = await ctx().request('POST', '/begin', { body: { provider: 'authtest' }, headers: { host: HOST, 'x-drobek-sdk': '' } });
    expect(res).toMatchObject({ status: 403, body: { error: 'csrf_rejected' } });
  });

  it('callback: a tampered, unknown, reused or foreign-provider state → 400 page, no handoff', async () => {
    const t = ctx();
    const b = await begin(t);
    const [id, sig] = b.state.split('.');
    const flipped = `${id}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(await callback(t, flipped)).toMatchObject({ kind: 'page', status: 400 });
    // the tampered attempt consumed the state: the genuine one is dead too
    expect(await callback(t, b.state)).toMatchObject({ kind: 'page', status: 400 });
    expect(await callback(t, `${'A'.repeat(43)}.${'B'.repeat(43)}`)).toMatchObject({ kind: 'page', status: 400 });
    expect(await callback(t, 'junk')).toMatchObject({ kind: 'page', status: 400 });
    expect(await t.endUserCallback({ provider: 'authtest', query: { code: 'idp-code' } })).toMatchObject({ kind: 'page', status: 400 });

    const b2 = await begin(t);
    expect(await t.endUserCallback({ provider: 'authtwo', query: { state: b2.state } })).toMatchObject({ kind: 'page', status: 400 });
    expect(await t.endUserCallback({ provider: 'Bad!', query: { state: b2.state } })).toMatchObject({ kind: 'page', status: 404 });

    const b3 = await begin(t);
    codeOf(await callback(t, b3.state));
    expect(await callback(t, b3.state)).toMatchObject({ kind: 'page', status: 400 });
  });

  it('callback: a state signed under another master key is refused', async () => {
    const t = ctx();
    const b = await begin(t);
    vi.stubEnv('DROBEK_MASTER_KEY', 'cd'.repeat(32));
    expect(await callback(t, b.state)).toMatchObject({ kind: 'page', status: 400 });
  });

  it('callback: the state in a POST form body (form_post / SAML RelayState) works', async () => {
    const t = ctx();
    const b = await begin(t);
    const r = await t.endUserCallback({ provider: 'authtest', method: 'POST', query: { code: 'idp-code' }, body: { RelayState: b.state } });
    expect(r.kind).toBe('redirect');
  });

  it('callback: the PKCE verifier must match what begin() committed to', async () => {
    const t = ctx();
    const b = await begin(t);
    challenges.set(b.state, sha256url('another verifier'));
    expect(await callback(t, b.state)).toMatchObject({ kind: 'page', status: 502 });
  });

  it('callback: an unverified e-mail → 403, audited, nobody created or linked', async () => {
    identity = { ...identity, emailVerified: false };
    const t = ctx();
    const b = await begin(t);
    const r = await callback(t, b.state);
    expect(r).toMatchObject({ kind: 'page', status: 403, title: 'E-mail address not verified', link: { href: `http://${HOST}/board?tab=2#top` } });
    expect(t.audits).toContainEqual({ action: 'auth.sign_in_denied', meta: { provider: 'authtest', reason: 'email_not_verified' } });
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it('callback: an address the allowlist does not admit → 403, audited', async () => {
    identity = { ...identity, email: 'mallory@evil.example' };
    const t = ctx();
    const r = await callback(t, (await begin(t)).state);
    expect(r).toMatchObject({ kind: 'page', status: 403, title: 'Not allowed' });
    expect(t.audits).toContainEqual({ action: 'auth.sign_in_denied', meta: { provider: 'authtest', reason: 'not_allowed' } });
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it('callback: an invalid identity from the provider → 502 page', async () => {
    identity = { subject: 'x', email: 'not an address', emailVerified: true };
    const t = ctx();
    expect(await callback(t, (await begin(t)).state)).toMatchObject({ kind: 'page', status: 502 });
  });

  it('callback: the provider turned off after begin → 404 page', async () => {
    const b = await begin(ctx());
    const off = ctx({ config: { providers: { authtest: { enabled: false, ...ISSUER } } } });
    expect(await callback(off, b.state)).toMatchObject({ kind: 'page', status: 404 });
  });

  it('callback: a state of an app that is no longer live → 404 page', async () => {
    const b = await begin(ctx({ appId: otherAppId, slug: 'other-app' }), '/', 'other-app--preview.apps.localhost:3041');
    // the test kit's services.app() knows only the test app (team-board)
    expect(await callback(ctx(), b.state)).toMatchObject({ kind: 'page', status: 404, title: 'App not available' });
  });

  it('callback: per client IP rate limit (AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN)', async () => {
    const t = ctx({ limits: { AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN: 2 } });
    await callback(t, 'junk');
    await callback(t, 'junk');
    expect(await callback(t, (await begin(t)).state)).toMatchObject({ kind: 'page', status: 429 });
  });

  it('complete: a replayed handoff code → 400 page, one session only', async () => {
    const t = ctx();
    const b = await begin(t);
    const code = codeOf(await callback(t, b.state));
    expect((await complete(t, code, b.flow)).status).toBe(302);
    const again = await complete(t, code, b.flow);
    expect(again.status).toBe(400);
    expect(again.headers['Content-Type']).toMatch(/text\/html/);
    expect(again.headers['Set-Cookie']).toBeUndefined();
  });

  it('complete: an expired handoff code → 400 page', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = ctx();
      const b = await begin(t);
      const code = codeOf(await callback(t, b.state));
      vi.setSystemTime(Date.now() + 61_000);
      expect((await complete(t, code, b.flow)).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('complete: the code used on another host of the app (production) or another app → 400, and it is spent', async () => {
    const t = ctx();
    const b = await begin(t);
    const code = codeOf(await callback(t, b.state));
    expect((await complete(t, code, b.flow, PROD_HOST)).status).toBe(400);
    expect((await complete(t, code, b.flow)).status).toBe(400);

    const b2 = await begin(t);
    const code2 = codeOf(await callback(t, b2.state));
    const other = ctx({ appId: otherAppId, slug: 'other-app' });
    expect((await complete(other, code2, b2.flow)).status).toBe(400);
  });

  it('complete: without the flow cookie of the browser that began (login CSRF) → 400 page, no session', async () => {
    const t = ctx();
    const b = await begin(t);
    const code = codeOf(await callback(t, b.state));
    const res = await complete(t, code, null);
    expect(res.status).toBe(400);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    const other = await begin(t);
    const b3 = await begin(t);
    const code3 = codeOf(await callback(t, b3.state));
    expect((await complete(t, code3, other.flow)).status).toBe(400);
  });

  it('complete: the allowlist changed between callback and complete → 403 page, audited', async () => {
    const t = ctx();
    const b = await begin(t);
    const code = codeOf(await callback(t, b.state));
    const narrowed = ctx({ config: { allow: { emails: [], domains: [], anyone: false } } });
    const res = await complete(narrowed, code, b.flow);
    expect(res.status).toBe(403);
    expect(narrowed.audits).toContainEqual({ action: 'auth.sign_in_denied', meta: { provider: 'authtest', reason: 'not_allowed' } });
  });
});

describe('auth providers — accounts and sessions', () => {
  async function emailUser(email: string): Promise<string> {
    const [row] = await db.insert(authUsers).values({ id: newId(), appId, email, role: 'user' }).returning();
    return row.id;
  }

  it('an e-mail user is linked by a VERIFIED address (same id); another identity with that address is refused', async () => {
    const id = await emailUser('ana@example.com');
    const t = ctx();
    const user = await me(t, await signInWithProvider(t));
    expect(user!.id).toBe(id);
    const [row] = await db.select().from(authUsers);
    expect(row).toMatchObject({ provider: 'authtest', subject: 'sub-ana' });

    identity = { ...identity, subject: 'sub-impostor' };
    const b = await begin(t);
    expect(await callback(t, b.state)).toMatchObject({ kind: 'page', status: 409 });
    expect(t.audits).toContainEqual({ action: 'auth.sign_in_denied', meta: { provider: 'authtest', reason: 'linked_elsewhere' } });
  });

  it('providerSignIn: the IdP moving an identity onto an address another user has → email_taken; a disabled user → disabled', async () => {
    await emailUser('eva@firma.cz');
    const first = await providerSignIn(db, appId, { provider: 'authtest', subject: 's1', email: 'ana@example.com', role: 'user' }, 10);
    expect(first).toMatchObject({ ok: true, isNew: true, linked: false });
    expect(await providerSignIn(db, appId, { provider: 'authtest', subject: 's1', email: 'eva@firma.cz', role: 'user' }, 10)).toEqual({ ok: false, reason: 'email_taken' });
    await db.update(authUsers).set({ disabledAt: new Date() });
    expect(await providerSignIn(db, appId, { provider: 'authtest', subject: 's1', email: 'ana@example.com', role: 'user' }, 10)).toEqual({ ok: false, reason: 'disabled' });
  });

  it('providerSignIn: the per-app user cap', async () => {
    await emailUser('eva@firma.cz');
    expect(await providerSignIn(db, appId, { provider: 'authtest', subject: 's2', email: 'ana@example.com', role: 'user' }, 1)).toEqual({ ok: false, reason: 'limit' });
  });

  it('the schema: an e-mail row has no subject, a provider row has one; (app, provider, subject) is unique', async () => {
    await expect(db.insert(authUsers).values({ id: newId(), appId, email: 'x@firma.cz', role: 'user', provider: 'email', subject: 's' })).rejects.toThrow();
    await expect(db.insert(authUsers).values({ id: newId(), appId, email: 'x@firma.cz', role: 'user', provider: 'authtest' })).rejects.toThrow();
    await expect(db.insert(authUsers).values({ id: newId(), appId, email: 'x@firma.cz', role: 'user', provider: 'Bad', subject: 's' })).rejects.toThrow();
    await db.insert(authUsers).values({ id: newId(), appId, email: 'x@firma.cz', role: 'user', provider: 'authtest', subject: 's' });
    await expect(db.insert(authUsers).values({ id: newId(), appId, email: 'y@firma.cz', role: 'user', provider: 'authtest', subject: 's' })).rejects.toThrow();
    await db.insert(authUsers).values({ id: newId(), appId: otherAppId, email: 'x@firma.cz', role: 'user', provider: 'authtest', subject: 's' });
  });

  it('current: a provider session ends when the provider is turned off (the e-mail code still on)', async () => {
    const t = ctx();
    const cookie = await signInWithProvider(t);
    expect(await me(t, cookie)).not.toBeNull();
    const off = ctx({ config: { providers: { emailCode: { enabled: true }, authtest: { enabled: false, ...ISSUER } } } });
    expect(await me(off, cookie)).toBeNull();
    // and endUsers.current (what every module request resolves) agrees
    const [row] = await db.select().from(authUsers);
    const cfg = off.module.configSchema.parse(off.module.configDefaults) as AuthConfig;
    expect(await auth.endUsers!.current({ app: { id: appId, slug: 'team-board', workspaceId }, user: { id: row.id, email: row.email, role: 'user', provider: 'authtest' }, config: { ...cfg, allow: { ...cfg.allow, anyone: true } }, db, log: capture() })).toBeNull();
  });

  it('current: an e-mail session ends when the e-mail code is turned off', async () => {
    const id = await emailUser('ana@example.com');
    const cfg = { ...(ON as unknown as AuthConfig), providers: { emailCode: { enabled: false }, authtest: { enabled: true, ...ISSUER } } };
    const app = { id: appId, slug: 'team-board', workspaceId };
    expect(await auth.endUsers!.current({ app, user: { id, email: 'ana@example.com', role: 'user' }, config: cfg, db, log: capture() })).toBeNull();
    expect(await auth.endUsers!.current({ app, user: { id, email: 'ana@example.com', role: 'user', provider: 'authtest' }, config: cfg, db, log: capture() })).not.toBeNull();
  });

  it("the owner's Users tab: a user whose sign-in method is off is not_allowed", async () => {
    await emailUser('eva@firma.cz');
    await providerSignIn(db, appId, { provider: 'authtest', subject: 's1', email: 'ana@example.com', role: 'user' }, 10);
    const cfg = { ...(ON as unknown as AuthConfig), providers: { emailCode: { enabled: false }, authtwo: { enabled: true }, authtest: { enabled: false, ...ISSUER } } };
    const view: OwnerView<AuthConfig> = { app: { id: appId, slug: 'team-board', workspaceId }, config: cfg, db, log: capture(), limits: async () => ({}) };
    const list = await auth.endUsers!.list!(view as never, {});
    expect(list.users.map((u) => [u.email, u.status, u.provider]).sort()).toEqual([
      ['ana@example.com', 'not_allowed', 'authtest'],
      ['eva@firma.cz', 'not_allowed', 'email'],
    ]);
    const on = { ...cfg, providers: { ...cfg.providers, authtest: { enabled: true, ...ISSUER } } };
    const again = await auth.endUsers!.list!({ ...view, config: on } as never, {});
    expect(again.users.find((u) => u.email === 'ana@example.com')!.status).toBe('active');
  });

  it('providerSecrets: only the provider’s own declared names; the app value before the env fallback', async () => {
    const s = providerSecrets(testProvider, async (n) => (n === 'AUTHTEST_CLIENT_SECRET' ? null : 'leak'), { AUTH_AUTHTEST_CLIENT_SECRET: ' env ' });
    expect(await s.get('AUTHTEST_CLIENT_SECRET')).toBe('env');
    await expect(s.get('MAIL_PASSWORD')).rejects.toThrow(/undeclared secret/);
    const own = providerSecrets(testProvider, async () => 'app-value', { AUTH_AUTHTEST_CLIENT_SECRET: 'env' });
    expect(await own.get('AUTHTEST_CLIENT_SECRET')).toBe('app-value');
    expect(await providerSecrets(testProvider, async () => null, {}).get('AUTHTEST_CLIENT_SECRET')).toBeNull();
  });
});
