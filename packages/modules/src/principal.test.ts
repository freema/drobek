/**
 * The end-user session seam: cookie, session records, the epoch (mass
 * revocation) and the core principal resolver every module relies on.
 */
import { describe, expect, it } from 'vitest';
import { FakeRedis } from '@drobek/auth';
import type { EndUser } from './contract.js';
import {
  END_USER_SESSION_TTL_SEC,
  cookiePrincipalResolver,
  createEndUserSession,
  destroyEndUserSession,
  endUserCookieHeader,
  endUserCookiesSecure,
  endUserEpochKey,
  endUserSessionKey,
  forgetEndUserSessions,
  loadEndUserSession,
  parseEndUserSession,
  readEndUserToken,
  renewEndUserSession,
  revokeEndUserSessions,
} from './principal.js';

const USER = { id: 'eu_1', email: 'ana@example.com', role: 'user' as const };

/** FakeRedis + SCAN (MATCH with `*`, a page of `count` keys per call). */
class ScanRedis extends FakeRedis {
  scans = 0;
  async scan(cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', count: number): Promise<[string, string[]]> {
    this.scans += 1;
    const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const keys = [...this.store.keys()].sort();
    const from = Number(cursor);
    const page = keys.slice(from, from + count);
    const next = from + count >= keys.length ? '0' : String(from + count);
    return [next, page.filter((k) => re.test(k))];
  }
}

describe('end-user cookie', () => {
  it('is host-only, HttpOnly, Lax; __Host- + Secure when secure', () => {
    expect(endUserCookieHeader('a'.repeat(64), { maxAgeSec: 60 }, true)).toBe(
      `__Host-drobek_eu=${'a'.repeat(64)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60`
    );
    expect(endUserCookieHeader('x', { maxAgeSec: 0, clear: true }, false)).toBe('drobek_eu=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });

  it('is secure in production and on an https apps origin; plain-http dev drops it', () => {
    expect(endUserCookiesSecure({ NODE_ENV: 'production' })).toBe(true);
    expect(endUserCookiesSecure({ APPS_DOMAIN: 'apps.example', APPS_URL_SCHEME: 'https', PUBLIC_APP_URL: 'https://x.example' })).toBe(true);
    expect(endUserCookiesSecure({ APPS_DOMAIN: 'apps.localhost:3041', PUBLIC_APP_URL: 'http://localhost:3041' })).toBe(false);
  });

  it('reads only a well-formed token of the right cookie name', () => {
    const t = 'b'.repeat(64);
    expect(readEndUserToken(`x=1; drobek_eu=${t}`, false)).toBe(t);
    expect(readEndUserToken(`drobek_eu=${t}`, true)).toBeNull();
    expect(readEndUserToken(`__Host-drobek_eu=${t}`, true)).toBe(t);
    expect(readEndUserToken('drobek_eu=../../etc', false)).toBeNull();
    expect(readEndUserToken(null, false)).toBeNull();
  });
});

describe('sessions + epoch', () => {
  it('create → load (TTL 30 days) → renew → destroy', async () => {
    const r = new FakeRedis();
    const token = await createEndUserSession(r, 'app1', USER);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await r.ttl(endUserSessionKey('app1', token))).toBeGreaterThan(END_USER_SESSION_TTL_SEC - 5);
    const s = await loadEndUserSession(r, 'app1', token);
    expect(s).toEqual({ ...USER, epoch: 0 });
    expect(await loadEndUserSession(r, 'app2', token)).toBeNull();
    await renewEndUserSession(r, 'app1', token, { ...s!, role: 'admin' });
    expect(await loadEndUserSession(r, 'app1', token)).toMatchObject({ role: 'admin' });
    await destroyEndUserSession(r, 'app1', token);
    expect(await loadEndUserSession(r, 'app1', token)).toBeNull();
  });

  it('revoking bumps the app epoch: every older session dies, new ones live, other apps untouched', async () => {
    const r = new FakeRedis();
    const a = await createEndUserSession(r, 'app1', USER);
    const b = await createEndUserSession(r, 'app1', { ...USER, id: 'eu_2' });
    const other = await createEndUserSession(r, 'app2', USER);
    expect(await revokeEndUserSessions(r, 'app1')).toBe(1);
    expect(await r.get(endUserEpochKey('app1'))).toBe('1');
    expect(await loadEndUserSession(r, 'app1', a)).toBeNull();
    expect(await loadEndUserSession(r, 'app1', b)).toBeNull();
    expect(await loadEndUserSession(r, 'app2', other)).not.toBeNull();
    const fresh = await createEndUserSession(r, 'app1', USER);
    expect(await loadEndUserSession(r, 'app1', fresh)).toEqual({ ...USER, epoch: 1 });
  });

  it('forgetting purged apps removes their sessions and epochs in one SCAN pass; other apps keep theirs', async () => {
    const r = new ScanRedis();
    const gone1 = await createEndUserSession(r, 'gone1', USER);
    const gone2 = await createEndUserSession(r, 'gone2', USER);
    const kept = await createEndUserSession(r, 'kept', USER);
    await revokeEndUserSessions(r, 'gone1');
    await revokeEndUserSessions(r, 'kept');
    for (let i = 0; i < 2500; i++) await r.set(`drobek:other:${i}`, 'x');
    expect(await forgetEndUserSessions(r, ['gone1', 'gone2'])).toBe(3);
    expect(r.scans).toBe(3);
    expect(await r.get(endUserSessionKey('gone1', gone1))).toBeNull();
    expect(await r.get(endUserSessionKey('gone2', gone2))).toBeNull();
    expect(await r.get(endUserEpochKey('gone1'))).toBeNull();
    expect(await r.get(endUserEpochKey('kept'))).toBe('1');
    expect(await r.get(endUserSessionKey('kept', kept))).not.toBeNull();
    expect(await forgetEndUserSessions(r, [])).toBe(0);
    expect(r.scans).toBe(3);
  });

  it('parse refuses malformed records (fail closed)', () => {
    expect(parseEndUserSession(JSON.stringify({ ...USER, epoch: 0 }))).toEqual({ ...USER, epoch: 0 });
    expect(parseEndUserSession(JSON.stringify(USER))).toBeNull();
    expect(parseEndUserSession(JSON.stringify({ ...USER, role: 'owner', epoch: 0 }))).toBeNull();
    expect(parseEndUserSession('{')).toBeNull();
  });

  it('a provider session keeps its provider and connection; the resolver hands both to the session owner', async () => {
    const r = new FakeRedis();
    const connection = 'c'.repeat(43);
    const token = await createEndUserSession(r, 'app1', { ...USER, provider: 'oidc', connection });
    expect(await loadEndUserSession(r, 'app1', token)).toEqual({ ...USER, provider: 'oidc', connection, epoch: 0 });
    expect(parseEndUserSession(JSON.stringify({ ...USER, epoch: 0, connection: 'bad value!' }))).toBeNull();
    await expect(createEndUserSession(r, 'app1', { ...USER, connection: 'x' })).rejects.toThrow(/connection/);
    const seen: EndUser[] = [];
    const resolve = cookiePrincipalResolver({ redis: () => r, secure: false, current: async (_app, u) => (seen.push(u), u) });
    expect(await resolve({ app: { id: 'app1', slug: 'one', workspaceId: 'ws1' }, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'user', ...USER });
    expect(seen).toEqual([{ ...USER, provider: 'oidc', connection }]);
  });
});

describe('cookiePrincipalResolver', () => {
  const APP1 = { id: 'app1', slug: 'one', workspaceId: 'ws1' };
  const APP2 = { id: 'app2', slug: 'two', workspaceId: 'ws1' };
  const same = async (_app: unknown, u: EndUser) => u;

  it('cookie → user of THIS app; foreign app, revoked, garbage or a Redis failure → anon', async () => {
    const r = new FakeRedis();
    const token = await createEndUserSession(r, 'app1', USER);
    const resolve = cookiePrincipalResolver({ redis: () => r, secure: false, current: same });
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'user', ...USER });
    expect(await resolve({ app: APP2, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'anon' });
    expect(await resolve({ app: APP1, cookieHeader: 'drobek_eu=nope' })).toEqual({ kind: 'anon' });
    expect(await resolve({ app: APP1, cookieHeader: null })).toEqual({ kind: 'anon' });
    r.failing = true;
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'anon' });
    r.failing = false;
    await revokeEndUserSessions(r, 'app1');
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'anon' });
  });

  it('asks the session owner every time: current role wins; null ends the session; a throw is anon for that request', async () => {
    const r = new FakeRedis();
    const token = await createEndUserSession(r, 'app1', USER);
    const cookie = `drobek_eu=${token}`;
    let answer: 'same' | 'admin' | 'gone' | 'throw' | 'other' = 'same';
    const seen: unknown[] = [];
    const resolve = cookiePrincipalResolver({
      redis: () => r,
      secure: false,
      current: async (app, u) => {
        seen.push({ app, u });
        if (answer === 'throw') throw new Error('db down');
        if (answer === 'gone') return null;
        if (answer === 'other') return { ...u, id: 'someone-else' };
        return answer === 'admin' ? { ...u, role: 'admin' } : u;
      },
    });
    expect(await resolve({ app: APP1, cookieHeader: cookie })).toEqual({ kind: 'user', ...USER });
    expect(seen[0]).toEqual({ app: APP1, u: { id: USER.id, email: USER.email, role: USER.role } });
    answer = 'admin';
    expect(await resolve({ app: APP1, cookieHeader: cookie })).toMatchObject({ kind: 'user', role: 'admin' });
    answer = 'throw';
    expect(await resolve({ app: APP1, cookieHeader: cookie })).toEqual({ kind: 'anon' });
    answer = 'same';
    expect(await resolve({ app: APP1, cookieHeader: cookie })).toMatchObject({ kind: 'user' }); // a throw kept the session
    answer = 'other';
    expect(await resolve({ app: APP1, cookieHeader: cookie })).toEqual({ kind: 'anon' });
    expect(await loadEndUserSession(r, 'app1', token)).toBeNull(); // a mismatch ends it
    const t2 = await createEndUserSession(r, 'app1', USER);
    answer = 'gone';
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${t2}` })).toEqual({ kind: 'anon' });
    expect(await loadEndUserSession(r, 'app1', t2)).toBeNull(); // deleted
    answer = 'same';
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${t2}` })).toEqual({ kind: 'anon' });
  });

  it('no session owner active (auth not enabled) → no session is honoured', async () => {
    const r = new FakeRedis();
    const token = await createEndUserSession(r, 'app1', USER);
    const resolve = cookiePrincipalResolver({ redis: () => r, secure: false, current: null });
    expect(await resolve({ app: APP1, cookieHeader: `drobek_eu=${token}` })).toEqual({ kind: 'anon' });
  });
});
