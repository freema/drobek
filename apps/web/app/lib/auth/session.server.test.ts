import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './fake-redis';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

import { SESSION_COOKIE, SESSION_MAX_AGE_SEC } from './constants';
import {
  createUserSession,
  destroySession,
  getSessionUser,
  requireSessionUser,
  sessionCookieHeader,
} from './session.server';

function requestWithCookie(cookie: string | null): Request {
  return new Request('http://localhost/me', {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

beforeEach(() => {
  fake = new FakeRedis();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sessionCookieHeader', () => {
  it('sets HttpOnly, Path=/, SameSite=Lax and a 30-day Max-Age (no Secure outside production)', () => {
    const header = sessionCookieHeader('a'.repeat(96), {
      maxAgeSec: SESSION_MAX_AGE_SEC,
    });
    expect(header).toContain(`${SESSION_COOKIE}=${'a'.repeat(96)}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${60 * 60 * 24 * 30}`);
    expect(header).not.toContain('Secure');
    expect(header).not.toContain('SameSite=None');
  });

  it('adds Secure only when NODE_ENV=production (still SameSite=Lax)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const header = sessionCookieHeader('b'.repeat(96), {
      maxAgeSec: SESSION_MAX_AGE_SEC,
    });
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
  });

  it('clear mode empties the value and sets Max-Age=0', () => {
    const header = sessionCookieHeader('', { maxAgeSec: 0, clear: true });
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });
});

describe('redis session round-trip', () => {
  it('createUserSession stores JSON under drobek:session:<token> with a 30-day TTL', async () => {
    const { token, setCookie } = await createUserSession('user_1', 'a@b.com');
    expect(token).toMatch(/^[0-9a-f]{96}$/);
    expect(setCookie).toContain(`${SESSION_COOKIE}=${token}`);

    const raw = await fake.get(`drobek:session:${token}`);
    const rec = JSON.parse(raw!) as {
      userId: string;
      email: string;
      createdAt: string;
    };
    expect(rec.userId).toBe('user_1');
    expect(rec.email).toBe('a@b.com');
    expect(rec.createdAt).toBeTruthy();

    const ttl = await fake.ttl(`drobek:session:${token}`);
    expect(ttl).toBeGreaterThan(SESSION_MAX_AGE_SEC - 5);
    expect(ttl).toBeLessThanOrEqual(SESSION_MAX_AGE_SEC);
  });

  it('getSessionUser resolves the user and refreshes the rolling TTL', async () => {
    const { token } = await createUserSession('user_2', 'roll@b.com');
    // Simulate an aged session: shrink the TTL, then read.
    await fake.pexpire(`drobek:session:${token}`, 60_000);
    expect(await fake.ttl(`drobek:session:${token}`)).toBeLessThanOrEqual(60);

    const user = await getSessionUser(
      requestWithCookie(`${SESSION_COOKIE}=${token}`)
    );
    expect(user).toEqual({ id: 'user_2', email: 'roll@b.com' });

    // Rolling refresh: back to the full 30 days.
    expect(await fake.ttl(`drobek:session:${token}`)).toBeGreaterThan(
      SESSION_MAX_AGE_SEC - 5
    );
  });

  it('returns null without a cookie, with a malformed token, or with an unknown token', async () => {
    expect(await getSessionUser(requestWithCookie(null))).toBeNull();
    expect(
      await getSessionUser(
        requestWithCookie(`${SESSION_COOKIE}=not-a-real-token`)
      )
    ).toBeNull();
    expect(
      await getSessionUser(
        requestWithCookie(`${SESSION_COOKIE}=${'c'.repeat(96)}`)
      )
    ).toBeNull();
  });

  it('requireSessionUser throws a redirect to /login when anonymous', async () => {
    try {
      await requireSessionUser(requestWithCookie(null));
      expect.unreachable('should have thrown');
    } catch (thrown) {
      const res = thrown as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login');
    }
  });

  it('destroySession deletes the redis key and returns a clearing cookie', async () => {
    const { token } = await createUserSession('user_3', 'bye@b.com');
    const clear = await destroySession(
      requestWithCookie(`${SESSION_COOKIE}=${token}`)
    );
    expect(clear).toContain('Max-Age=0');
    expect(await fake.get(`drobek:session:${token}`)).toBeNull();
    expect(
      await getSessionUser(requestWithCookie(`${SESSION_COOKIE}=${token}`))
    ).toBeNull();
  });
});
