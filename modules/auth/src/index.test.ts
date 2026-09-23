/**
 * The auth module under createModuleTestContext(): real routes through the
 * production pipeline, PGlite with the core + auth migrations, the OTP code
 * and sessions in an in-memory Redis (the FakeRedis of @drobek/auth).
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import { apps, memberships, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import {
  buildSdk,
  cookiePrincipalResolver,
  endUserSessionKey,
  isDefinedModule,
  loadModules,
  memoryMailGuard,
  mergePatch,
  revokeEndUserSessions,
  type OwnerView,
} from '@drobek/modules';
import { createModuleTestContext, type ModuleTestContext } from '@drobek/modules/testing';
import { noopLogger } from '@drobek/core';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return { ...actual, getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis> };
});

import auth, { AUTH_CONFIG_DEFAULTS, authConfigSchema, authConfirmRequired, decideSignIn, safeName, signInEmail } from './index.js';
import { appHourlyCodeCap } from './routes.js';
import { authUsers } from './schema.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const HOST = 'team-board--preview.apps.localhost';

let pg: PGlite;
let db: DB;
let appId: string;
let workspaceId: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: auth.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_auth', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'auth-ws', name: 'Auth' }).returning();
  workspaceId = ws.id;
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'team-board', name: 'Team\r\nBcc: evil@example.com board' }).returning();
  appId = app.id;
  const [editor] = await d.insert(users).values({ email: 'builder@example.com' }).returning();
  const [viewer] = await d.insert(users).values({ email: 'viewer@example.com' }).returning();
  await d.insert(memberships).values([
    { userId: editor.id, workspaceId: ws.id, role: 'editor' },
    { userId: viewer.id, workspaceId: ws.id, role: 'viewer' },
  ]);
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  fake = new FakeRedis();
  await db.delete(authUsers);
});

const CONFIG = { allow: { emails: ['ana@example.com'], domains: ['firma.cz'], anyone: false }, adminEmails: ['boss@example.com'] };

function ctx(opts: { config?: Record<string, unknown>; limits?: Record<string, number> } = {}): ModuleTestContext {
  return createModuleTestContext(auth, { db, app: { id: appId, slug: 'team-board', workspaceId }, config: opts.config ?? CONFIG, limits: opts.limits, origin: `http://${HOST}` });
}

/**
 * What core resolves for EVERY module request (the principal other modules
 * see): the session, then this module's endUsers.current with `config`.
 */
function resolver(config: Record<string, unknown> = CONFIG) {
  const parsed = authConfigSchema.parse(config);
  return cookiePrincipalResolver({
    redis: () => fake,
    secure: false,
    current: (app, user) => auth.endUsers!.current({ app, user, config: parsed, db, log: noopLogger }),
  });
}
const APP = () => ({ id: appId, slug: 'team-board', workspaceId });

const emailHash = (e: string) => createHash('sha256').update(e).digest('hex');

function cookieOf(res: { headers: Record<string, string> }): string {
  const set = res.headers['Set-Cookie'];
  expect(set, 'Set-Cookie').toBeTruthy();
  return set.split(';')[0];
}

/** send-code → the code from the captured e-mail → verify → the session cookie. */
async function signIn(t: ModuleTestContext, email: string): Promise<{ cookie: string; body: unknown }> {
  const sent = await t.request('POST', '/send-code', { body: { email }, headers: { host: HOST } });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const mail = t.emails.at(-1)!;
  const code = /\b(\d{6})\b/.exec(mail.subject)![1];
  const res = await t.request('POST', '/verify', { body: { email, code } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { cookie: cookieOf(res), body: res.body };
}

describe('drobek-module-auth — module shape', () => {
  it('is a defined module the registry accepts by its short name', async () => {
    expect(isDefinedModule(auth)).toBe(true);
    const mods = await loadModules({ DROBEK_MODULES: 'auth' }, { importer: async (pkg) => (pkg === 'drobek-module-auth' ? { default: auth } : null) });
    expect(mods.map((m) => m.name)).toEqual(['auth']);
  });

  it('config: defaults valid; e-mails/domains normalized; unknown keys and bad values refused with paths', () => {
    expect(authConfigSchema.parse(AUTH_CONFIG_DEFAULTS)).toEqual(AUTH_CONFIG_DEFAULTS);
    const ok = authConfigSchema.parse({ allow: { emails: [' Ana@Example.COM '], domains: ['Firma.CZ'], anyone: false }, adminEmails: [] });
    expect(ok.allow).toEqual({ emails: ['ana@example.com'], domains: ['firma.cz'], anyone: false });
    const bad = authConfigSchema.safeParse({ allow: { emails: ['nope'], domains: ['@firma.cz'], anyone: false, extra: 1 }, adminEmails: [] });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.'))).toEqual(expect.arrayContaining(['allow.emails.0', 'allow.domains.0']));
    expect(authConfigSchema.safeParse({ allowlist: [], ...AUTH_CONFIG_DEFAULTS }).success).toBe(false);
  });

  it('only opening sign-in to anyone needs the owner', () => {
    const d = AUTH_CONFIG_DEFAULTS;
    expect(authConfirmRequired(d, { ...d, allow: { ...d.allow, anyone: true } })).toEqual([
      'allow.anyone: false → true (anyone with an e-mail address can sign in to this app)',
    ]);
    expect(authConfirmRequired(d, { ...d, allow: { ...d.allow, emails: ['a@b.cz'] }, adminEmails: ['c@d.cz'] })).toEqual([]);
    expect(authConfirmRequired({ ...d, allow: { ...d.allow, anyone: true } }, d)).toEqual([]);
  });

  it('decideSignIn: admins, workspace editors, allowlist, domains, anyone', () => {
    const c = authConfigSchema.parse(CONFIG);
    const at = (email: string, workspaceEditor = false) => decideSignIn({ config: c, email, workspaceEditor });
    expect(at('boss@example.com')).toEqual({ allowed: true, role: 'admin' });
    expect(at('builder@example.com', true)).toEqual({ allowed: true, role: 'admin' });
    expect(at('ana@example.com')).toEqual({ allowed: true, role: 'user' });
    expect(at('x@firma.cz')).toEqual({ allowed: true, role: 'user' });
    expect(at('x@sub.firma.cz')).toEqual({ allowed: false });
    expect(at('eve@example.com')).toEqual({ allowed: false });
    expect(decideSignIn({ config: { ...c, allow: { ...c.allow, anyone: true } }, email: 'eve@x.io', workspaceEditor: false })).toEqual({ allowed: true, role: 'user' });
  });

  it('the skill follows the skill format, ≤ 150 lines, with a LoginGate example', () => {
    const md = auth.skill.markdown;
    expect(md.split('\n').length).toBeLessThanOrEqual(150);
    expect(md).toContain("import { LoginGate } from 'drobek/auth';");
    for (const h of ['## 1. Say who may sign in', '## 2. Minimal working code', '## SDK', '## What the server enforces', '## Common errors']) {
      expect(md).toContain(h);
    }
    for (const code of ['email_not_allowed', 'invalid_code', 'too_many_attempts', 'rate_limited']) expect(md).toContain(code);
    for (const l of auth.limits!) expect(md).toContain(l.env);
  });

  it('bundles drobek.auth into sdk.js and exposes drobek/auth as an inline source', async () => {
    const sdk = await buildSdk([auth]);
    const js = sdk.js.toString('utf8');
    expect(js).toContain('"auth"');
    expect(js).toContain('/send-code');
    expect(js).not.toContain('LoginGate');
    expect(Object.keys(sdk.inline)).toEqual(['drobek/auth']);
    expect(sdk.inline['drobek/auth']).toContain('export function LoginGate');
    expect(sdk.dts).toContain('readonly auth: auth.Api;');
    expect(sdk.dts).toContain("from 'drobek/auth'");
  });

  it('the skill\'s React example compiles with the react-ts import map (one React, drobek → the SDK)', async () => {
    const { compile } = await import('@drobek/compile');
    const sdk = await buildSdk([auth]);
    const example = /```tsx\n([\s\S]*?)```/.exec(auth.skill.markdown)![1];
    const r = await compile(
      new Map([
        ['drobek.json', JSON.stringify({ imports: { react: 'https://esm.sh/react@19.1.0', 'react/jsx-runtime': 'https://esm.sh/react@19.1.0/jsx-runtime', 'react-dom': 'https://esm.sh/react-dom@19.1.0?deps=react@19.1.0', 'react-dom/client': 'https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0' } })],
        ['src/main.tsx', example],
        ['src/styles.css', 'body { margin: 0; }'],
      ]),
      { sdkUrl: sdk.url, sdkSources: sdk.inline }
    );
    expect(r.errors).toEqual([]);
    const js = r.outputs.get('main.js')!.toString('utf8');
    expect(js).toContain('function LoginGate(');
    expect(js).toContain(`from "${sdk.url}"`);
    expect(js).not.toMatch(/from "https:\/\/esm\.sh\/react@(?!19\.1\.0)/);
  });
});

describe('drobek-module-auth — sign-in', () => {
  it('an e-mail outside the allowlist → 403 email_not_allowed, and NO code is created or sent', async () => {
    const t = ctx();
    const res = await t.request('POST', '/send-code', { body: { email: 'eve@example.com' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'email_not_allowed', hint: "skill_info('auth')" });
    expect(t.emails).toEqual([]);
    expect([...fake.store.keys()].some((k) => k.includes(':code:'))).toBe(false);
  });

  it('notifications paused server-wide: codes still go out; the sign-in budget used up → 503 email_paused, the cooldown released', async () => {
    // G = 4: sign-in codes 2, notifications 2 — which another app has used up (paused).
    const guard = memoryMailGuard({ hourlyMax: 4, pauseMinutes: 15, appSharePercent: 100 }, noopLogger);
    const forms = { app_id: 'app_other', module: 'forms', kind: 'notification' as const };
    await guard.admit(2, forms);
    await expect(guard.admit(1, forms)).rejects.toMatchObject({ details: { reason: 'email_paused', class: 'notification' } });
    await expect(guard.assertOpen(forms)).rejects.toMatchObject({ status: 503 });

    // Another app already sent one of the two sign-in codes (one app alone
    // stops at its own share of 2 first — the next test).
    await guard.admit(1, { app_id: 'app_other', module: 'auth', kind: 'sign_in' });

    const t = createModuleTestContext(auth, { db, app: APP(), config: CONFIG, origin: `http://${HOST}`, mailGuard: guard });
    const sent = await t.request('POST', '/send-code', { body: { email: 'ana@example.com' }, headers: { host: HOST } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(t.emails.map((m) => [m.to, m.kind])).toEqual([[['ana@example.com'], 'sign_in']]);
    // The sign-in budget (2) is used up too: the pause is passed on as it is.
    const refused = await t.request('POST', '/send-code', { body: { email: 'eva@firma.cz' }, headers: { host: HOST } });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: 'unavailable', details: { reason: 'email_paused', class: 'sign_in' } });
    expect(refused.headers['Retry-After']).toBe('900');
    expect(t.emails).toHaveLength(1);
    // Nothing went out: the per-address cooldown is released for a retry.
    expect(await fake.get(`drobek:otp:eu:${appId}:cd:${emailHash('eva@firma.cz')}`)).toBeNull();
  });

  it("the app's hourly code cap is clamped to its share of the server's sign-in budget (NSO-322 H2)", async () => {
    expect(appHourlyCodeCap(100, 25)).toBe(25);
    expect(appHourlyCodeCap(10, 25)).toBe(10);
    expect(appHourlyCodeCap(100, undefined)).toBe(100);
    // Defaults: sign-in 100 an hour server-wide, one app 25 of them; AUTH_CODES_PER_APP_HOUR 100.
    const guard = memoryMailGuard({ hourlyMax: 500, pauseMinutes: 15 }, noopLogger);
    const t = createModuleTestContext(auth, {
      db,
      app: APP(),
      config: { ...CONFIG, allow: { ...CONFIG.allow, anyone: true } },
      origin: `http://${HOST}`,
      mailGuard: guard,
      limits: { AUTH_CODES_PER_IP_15MIN: 1000, AUTH_CODES_PER_IP_DAY: 1000, AUTH_ATTEMPTS_PER_IP_15MIN: 1000 },
    });
    for (let i = 0; i < 25; i++) {
      const sent = await t.request('POST', '/send-code', { body: { email: `u${i}@example.org` }, headers: { host: HOST } });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    // The 26th: the app's own brake pauses THIS app (15 min) — the server's
    // sign-in budget is not touched, so other apps keep signing people in.
    const over = await t.request('POST', '/send-code', { body: { email: 'u25@example.org' }, headers: { host: HOST } });
    expect(over.status).toBe(503);
    expect(over.headers['Retry-After']).toBe('900');
    expect(t.emails).toHaveLength(25);
    await expect(guard.assertOpen({ app_id: 'app_other', module: 'auth', kind: 'sign_in' })).resolves.toBeUndefined();
    await guard.admit(1, { app_id: 'app_other', module: 'auth', kind: 'sign_in' });
  });

  it('an allowed e-mail gets a code (scoped key, safe subject) → verify → session cookie + user → me', async () => {
    const t = ctx();
    const sent = await t.request('POST', '/send-code', { body: { email: ' Ana@Example.com ' }, headers: { host: HOST } });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: true, email: 'ana@example.com', expires_in: 600 });
    expect(await fake.get(`drobek:otp:eu:${appId}:code:${emailHash('ana@example.com')}`)).not.toBeNull();
    expect(t.emails).toHaveLength(1);
    const mail = t.emails[0];
    expect(mail.to).toEqual(['ana@example.com']);
    // The app name carries a header-injection attempt: one line, no CR/LF.
    expect(mail.subject).toMatch(/^\d{6} is your sign-in code for Team Bcc: evil@example\.com board$/);
    expect(mail.text).toContain(`on ${HOST}`);

    const code = /\b(\d{6})\b/.exec(mail.subject)![1];
    const res = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: 'ana@example.com', role: 'user', id: expect.stringMatching(/^eu_[0-9a-f]{24}$/) } });
    const set = res.headers['Set-Cookie'];
    expect(set).toMatch(/^drobek_eu=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(set).not.toMatch(/Domain=/i);
    expect(t.audits).toEqual([{ action: 'auth.sign_in', meta: expect.objectContaining({ role: 'user', new_user: true }) }]);

    const [row] = await db.select().from(authUsers).where(eq(authUsers.appId, appId));
    expect(row).toMatchObject({ email: 'ana@example.com', role: 'user', disabledAt: null });
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.lastLoginAt).toBeInstanceOf(Date);

    const cookie = cookieOf(res);
    const me = await t.request('GET', '/me', { headers: { cookie } });
    expect(me.body).toEqual({ user: { id: row.id, email: 'ana@example.com', role: 'user' } });
    expect(me.headers['Set-Cookie']).toContain('Max-Age=2592000');
    expect((await t.request('GET', '/me')).body).toEqual({ user: null });

    // The code is single-use.
    const again = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code } });
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_code' } });

    // Core resolves the same cookie into the principal every other module sees.
    const resolve = resolver();
    expect(await resolve({ app: APP(), cookieHeader: cookie })).toEqual({ kind: 'user', id: row.id, email: 'ana@example.com', role: 'user' });
    expect(await resolve({ app: { ...APP(), id: 'another-app' }, cookieHeader: cookie })).toEqual({ kind: 'anon' });
  });

  it('the 6th wrong code (and even the right one after) → too_many_attempts; a concurrent flood is capped (PHY-76 #1)', async () => {
    const t = ctx();
    await t.request('POST', '/send-code', { body: { email: 'ana@example.com' } });
    const code = /\b(\d{6})\b/.exec(t.emails[0].subject)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    const errors: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code: wrong } });
      errors.push((r.body as { error: string }).error);
    }
    expect(errors).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'too_many_attempts', 'too_many_attempts']);
    const right = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code } });
    expect(right).toMatchObject({ status: 429, body: { error: 'too_many_attempts' } });

    // A fresh code, then 40 concurrent wrong guesses: at most 4 are evaluated, none succeeds.
    const t2 = ctx({ limits: { AUTH_ATTEMPTS_PER_IP_15MIN: 1000 } });
    await t2.request('POST', '/send-code', { body: { email: 'x@firma.cz' } });
    const code2 = /\b(\d{6})\b/.exec(t2.emails[0].subject)![1];
    const wrong2 = code2 === '000000' ? '111111' : '000000';
    const flood = await Promise.all(
      Array.from({ length: 40 }, () => t2.request('POST', '/verify', { body: { email: 'x@firma.cz', code: wrong2 } }))
    );
    expect(flood.filter((r) => (r.body as { error: string }).error === 'invalid_code').length).toBeLessThanOrEqual(4);
    expect(flood.some((r) => r.status === 200)).toBe(false);
    expect((await t2.request('POST', '/verify', { body: { email: 'x@firma.cz', code: code2 } })).body).toMatchObject({ error: 'too_many_attempts' });
  });

  it('adminEmails and workspace editors sign in as admin; a viewer of the workspace does not', async () => {
    const t = ctx();
    expect((await signIn(t, 'boss@example.com')).body).toMatchObject({ user: { role: 'admin' } });
    expect((await signIn(t, 'builder@example.com')).body).toMatchObject({ user: { role: 'admin' } });
    const viewer = await t.request('POST', '/send-code', { body: { email: 'viewer@example.com' } });
    expect(viewer).toMatchObject({ status: 403, body: { error: 'email_not_allowed' } });
  });

  it('revoking the app epoch signs every session out; a new sign-in works again', async () => {
    const t = ctx();
    const a = await signIn(t, 'ana@example.com');
    const b = await signIn(t, 'boss@example.com');
    const resolve = resolver();
    expect((await resolve({ app: APP(), cookieHeader: a.cookie })).kind).toBe('user');

    expect(await revokeEndUserSessions(fake, appId)).toBe(1);
    for (const s of [a, b]) {
      const me = await t.request('GET', '/me', { headers: { cookie: s.cookie } });
      expect(me.body).toEqual({ user: null });
      expect(me.headers['Set-Cookie']).toMatch(/Max-Age=0/);
      expect(await resolve({ app: APP(), cookieHeader: s.cookie })).toEqual({ kind: 'anon' });
    }
    // (ana is still in her 60 s code cooldown: a new send answers "sent" and sends nothing.)
    const before = t.emails.length;
    expect((await t.request('POST', '/send-code', { body: { email: 'ana@example.com' } })).body).toMatchObject({ sent: true });
    expect(t.emails.length).toBe(before);
    const c = await signIn(t, 'x@firma.cz');
    expect((await t.request('GET', '/me', { headers: { cookie: c.cookie } })).body).toMatchObject({ user: { email: 'x@firma.cz' } });
  });

  it('a disabled user cannot get a code and is signed out on the next me', async () => {
    const t = ctx();
    const s = await signIn(t, 'ana@example.com');
    await db.update(authUsers).set({ disabledAt: new Date() }).where(eq(authUsers.email, 'ana@example.com'));
    const me = await t.request('GET', '/me', { headers: { cookie: s.cookie } });
    expect(me.body).toEqual({ user: null });
    const token = s.cookie.split('=')[1];
    expect(await fake.get(endUserSessionKey(appId, token))).toBeNull();
    const send = await t.request('POST', '/send-code', { body: { email: 'ana@example.com' } });
    expect(send).toMatchObject({ status: 403, body: { error: 'email_not_allowed' } });
  });

  it('me follows the config: removed from the allowlist → signed out; adminEmails → role admin', async () => {
    const t = ctx();
    const s = await signIn(t, 'ana@example.com');
    const promoted = ctx({ config: { ...CONFIG, adminEmails: ['ana@example.com'] } });
    expect((await promoted.request('GET', '/me', { headers: { cookie: s.cookie } })).body).toMatchObject({ user: { role: 'admin' } });
    const [row] = await db.select().from(authUsers).where(eq(authUsers.email, 'ana@example.com'));
    expect(row.role).toBe('admin');
    const removed = ctx({ config: { ...CONFIG, allow: { ...CONFIG.allow, emails: [] }, adminEmails: [] } });
    expect((await removed.request('GET', '/me', { headers: { cookie: s.cookie } })).body).toEqual({ user: null });
  });

  it('the core principal (what every OTHER module sees) follows the user at once — no me() needed', async () => {
    const t = ctx();
    const ana = await signIn(t, 'ana@example.com');
    const boss = await signIn(t, 'boss@example.com');
    const builder = await signIn(t, 'builder@example.com'); // workspace editor, not in the allowlist
    const [anaRow] = await db.select().from(authUsers).where(eq(authUsers.email, 'ana@example.com'));
    const resolve = resolver();
    expect(await resolve({ app: APP(), cookieHeader: boss.cookie })).toMatchObject({ kind: 'user', role: 'admin' });

    // Dropped from adminEmails → a plain user on the very next request.
    const demoted = resolver({ ...CONFIG, allow: { ...CONFIG.allow, emails: ['ana@example.com', 'boss@example.com'] }, adminEmails: [] });
    expect(await demoted({ app: APP(), cookieHeader: boss.cookie })).toMatchObject({ kind: 'user', role: 'user' });
    // Promoted by the config → admin at once.
    const promoted = resolver({ ...CONFIG, adminEmails: ['ana@example.com'] });
    expect(await promoted({ app: APP(), cookieHeader: ana.cookie })).toMatchObject({ kind: 'user', role: 'admin' });

    // Disabled → anonymous and the session is gone (it does not come back when re-enabled).
    await db.update(authUsers).set({ disabledAt: new Date() }).where(eq(authUsers.id, anaRow.id));
    expect(await resolve({ app: APP(), cookieHeader: ana.cookie })).toEqual({ kind: 'anon' });
    expect(await fake.get(endUserSessionKey(appId, ana.cookie.split('=')[1]))).toBeNull();
    await db.update(authUsers).set({ disabledAt: null }).where(eq(authUsers.id, anaRow.id));
    expect(await resolve({ app: APP(), cookieHeader: ana.cookie })).toEqual({ kind: 'anon' });

    // Removed from the allowlist → anonymous.
    const removed = resolver({ ...CONFIG, adminEmails: [] });
    expect(await removed({ app: APP(), cookieHeader: boss.cookie })).toEqual({ kind: 'anon' });

    // An editor who lost the workspace membership → anonymous.
    expect(await resolve({ app: APP(), cookieHeader: builder.cookie })).toMatchObject({ kind: 'user', role: 'admin' });
    const [editor] = await db.select().from(users).where(eq(users.email, 'builder@example.com'));
    await db.delete(memberships).where(eq(memberships.userId, editor.id));
    try {
      expect(await resolve({ app: APP(), cookieHeader: builder.cookie })).toEqual({ kind: 'anon' });
    } finally {
      await db.insert(memberships).values({ userId: editor.id, workspaceId, role: 'editor' });
    }

    // A deleted user → anonymous.
    const x = await signIn(t, 'x@firma.cz');
    await db.delete(authUsers).where(eq(authUsers.email, 'x@firma.cz'));
    expect(await resolve({ app: APP(), cookieHeader: x.cookie })).toEqual({ kind: 'anon' });
  });

  it('logout ends the session and clears the cookie', async () => {
    const t = ctx();
    const s = await signIn(t, 'ana@example.com');
    const out = await t.request('POST', '/logout', { headers: { cookie: s.cookie } });
    expect(out.status).toBe(200);
    expect(out.headers['Set-Cookie']).toBe('drobek_eu=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await t.request('GET', '/me', { headers: { cookie: s.cookie } })).body).toEqual({ user: null });
  });

  it('mutations need the SDK header and the app\'s own origin', async () => {
    const t = ctx();
    const noSdk = await t.request('POST', '/send-code', { body: { email: 'ana@example.com' }, headers: { 'x-drobek-sdk': '' } });
    expect(noSdk).toMatchObject({ status: 403, body: { error: 'csrf_rejected' } });
    const foreign = await t.request('POST', '/verify', { body: { email: 'ana@example.com', code: '123456' }, headers: { origin: 'https://evil.example' } });
    expect(foreign).toMatchObject({ status: 403, body: { error: 'csrf_rejected' } });
    expect(t.emails).toEqual([]);
  });

  it('limits: codes per IP (guard, per app) and END_USERS_MAX_PER_APP', async () => {
    const t = ctx({ limits: { AUTH_CODES_PER_IP_15MIN: 2 } });
    expect((await t.request('POST', '/send-code', { body: { email: 'a1@firma.cz' } })).status).toBe(200);
    expect((await t.request('POST', '/send-code', { body: { email: 'a2@firma.cz' } })).status).toBe(200);
    const third = await t.request('POST', '/send-code', { body: { email: 'a3@firma.cz' } });
    expect(third).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(third.headers['Retry-After']).toBe('900');

    const capped = ctx({ limits: { END_USERS_MAX_PER_APP: 1 } });
    await signIn(capped, 'ana@example.com');
    const second = await capped.request('POST', '/send-code', { body: { email: 'b@firma.cz' } });
    expect(second).toMatchObject({ status: 429, body: { error: 'limit_exceeded' } });
    // An existing user still signs in.
    expect((await capped.request('POST', '/send-code', { body: { email: 'ana@example.com' } })).status).toBe(200);
  });

  it('the attempts limit counts send-code + verify per IP', async () => {
    const t = ctx({ limits: { AUTH_ATTEMPTS_PER_IP_15MIN: 2 } });
    await t.request('POST', '/verify', { body: { email: 'ana@example.com', code: '123456' } });
    await t.request('POST', '/verify', { body: { email: 'ana@example.com', code: '123456' } });
    const third = await t.request('POST', '/send-code', { body: { email: 'ana@example.com' } });
    expect(third).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });

  it('the sign-in e-mail text is plain and bounded', () => {
    expect(safeName('  a\u0000b\nc  ')).toBe('a b c');
    expect(safeName('x'.repeat(100))).toHaveLength(60);
    expect(safeName('')).toBe('this app');
    const m = signInEmail({ appName: '<b>Shop</b>', host: null, code: '123456' });
    expect(m.subject).toBe('123456 is your sign-in code for <b>Shop</b>');
    expect(m.text).not.toContain(' on ');
  });
});

describe("drobek-module-auth — the owner's view (M2-03)", () => {
  type Config = ReturnType<typeof authConfigSchema.parse>;
  const view = (config: Config): OwnerView<Config> => ({ app: APP(), config, db, log: noopLogger, limits: async () => ({}) });
  const owner = auth.endUsers!;

  async function seedUser(email: string, at: string, extra: Partial<typeof authUsers.$inferInsert> = {}): Promise<string> {
    const id = `eu_${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
    await db.insert(authUsers).values({ id, appId, email, role: 'user', createdAt: new Date(at), lastLoginAt: new Date(at), ...extra });
    return id;
  }
  const now = async (config: Config, id: string, email: string) => owner.current({ app: APP(), user: { id, email, role: 'user' }, config, db, log: noopLogger });

  it('list: role and why, status, search, keyset pages (newest first)', async () => {
    const config = authConfigSchema.parse(CONFIG);
    await seedUser('ana@example.com', '2026-09-01T10:00:00Z');
    await seedUser('boss@example.com', '2026-09-02T10:00:00Z');
    await seedUser('builder@example.com', '2026-09-03T10:00:00Z');
    await seedUser('gone@example.com', '2026-09-04T10:00:00Z');
    await seedUser('eva@firma.cz', '2026-09-05T10:00:00Z', { disabledAt: new Date() });

    const all = await owner.list!(view(config), {});
    expect(all.total).toBe(5);
    expect(all.users.map((u) => [u.email, u.role, u.roleSource, u.status])).toEqual([
      ['eva@firma.cz', 'user', null, 'disabled'],
      ['gone@example.com', 'user', null, 'not_allowed'],
      ['builder@example.com', 'admin', 'workspace', 'active'],
      ['boss@example.com', 'admin', 'config', 'active'],
      ['ana@example.com', 'user', null, 'active'],
    ]);
    expect((await owner.list!(view(config), { search: 'EXAMPLE.com' })).total).toBe(4);
    expect((await owner.list!(view(config), { search: '%' })).total).toBe(0);
    const p1 = await owner.list!(view(config), { limit: 2 });
    const p2 = await owner.list!(view(config), { limit: 2, cursor: p1.next_cursor });
    const p3 = await owner.list!(view(config), { limit: 2, cursor: p2.next_cursor });
    expect([...p1.users, ...p2.users, ...p3.users].map((u) => u.email)).toHaveLength(5);
    expect(p3.next_cursor).toBeNull();
    await expect(owner.list!(view(config), { cursor: 'junk' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('setRole returns the config patch that gives the role; the next current() answers with it', async () => {
    let config = authConfigSchema.parse(CONFIG);
    const ana = await seedUser('ana@example.com', '2026-09-01T10:00:00Z');
    const boss = await seedUser('boss@example.com', '2026-09-02T10:00:00Z');
    const apply = (patch: Record<string, unknown> | null) => {
      if (patch) config = authConfigSchema.parse(mergePatch(config, patch));
    };

    const up = await owner.setRole!(view(config), ana, 'admin');
    expect(up.configPatch).toEqual({ adminEmails: ['boss@example.com', 'ana@example.com'] });
    expect(up.user).toMatchObject({ role: 'admin', roleSource: 'config' });
    apply(up.configPatch);
    expect(await now(config, ana, 'ana@example.com')).toMatchObject({ role: 'admin' });

    // boss is admin only through adminEmails: demoted, they stay allowed as a user.
    const down = await owner.setRole!(view(config), boss, 'user');
    expect(down.configPatch).toEqual({ adminEmails: ['ana@example.com'], allow: { emails: ['ana@example.com', 'boss@example.com'] } });
    apply(down.configPatch);
    expect(await now(config, boss, 'boss@example.com')).toMatchObject({ role: 'user' });
    expect(config.allow).toMatchObject({ domains: ['firma.cz'], anyone: false });

    // Unchanged role → no patch.
    expect((await owner.setRole!(view(config), ana, 'admin')).configPatch).toBeNull();
    await expect(owner.setRole!(view(config), 'eu_000000000000000000000000', 'admin')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a workspace editor is always admin (conflict); setDisabled blocks and unblocks (current null → back)', async () => {
    const config = authConfigSchema.parse(CONFIG);
    const builder = await seedUser('builder@example.com', '2026-09-01T10:00:00Z');
    await expect(owner.setRole!(view(config), builder, 'user')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'workspace_editor' } });

    const ana = await seedUser('ana@example.com', '2026-09-02T10:00:00Z');
    expect(await owner.setDisabled!(view(config), ana, true)).toMatchObject({ status: 'disabled' });
    expect(await now(config, ana, 'ana@example.com')).toBeNull();
    expect(await owner.setDisabled!(view(config), ana, false)).toMatchObject({ status: 'active' });
    expect(await now(config, ana, 'ana@example.com')).toMatchObject({ role: 'user' });
    expect(await owner.setDisabled!(view(config), 'eu_000000000000000000000000', true)).toBeNull();
  });
});
