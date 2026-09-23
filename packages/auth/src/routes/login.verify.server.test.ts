import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from '../fake-redis.js';

let fake: FakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

vi.mock('../logger.server.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (err: unknown) => ({ message: String(err) }),
}));

vi.mock('../ensure-user.server.js', () => ({
  ensureUserByEmail: vi.fn(async () => 'user_1'),
}));

vi.mock('../session.server.js', () => ({
  createUserSession: vi.fn(async () => ({ setCookie: 'drobek_session=x; Path=/' })),
}));

import type { ActionFunctionArgs } from 'react-router';
import { CODE_MAX_ATTEMPTS, createEmailLoginCode } from '../email-code.server.js';
import { action } from './login.verify.server.js';

function verifyRequest(email: string, code: string, headers: Record<string, string> = {}): ActionFunctionArgs {
  const request = new Request('http://localhost/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ email, code }).toString(),
  });
  return { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
}

/** 'signed-in' for the /me redirect, else the HTTP status of the error. */
async function outcome(res: unknown): Promise<'signed-in' | number> {
  if (res instanceof Response) {
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/me');
    return 'signed-in';
  }
  return (res as { init?: { status?: number } }).init?.status ?? 200;
}

/** A wrong code that is guaranteed to differ from `code`. */
function wrong(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

beforeEach(() => {
  fake = new FakeRedis();
  vi.stubEnv('TRUST_PROXY', 'x-real-ip');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /login/verify — no client IP (NSO-309)', () => {
  it('many IP-less clients are never coupled: sign-ins far past the per-IP limit all succeed', async () => {
    vi.stubEnv('OTP_VERIFY_IP_LIMIT', '3');
    // 40 checks: past both the env limit (3) and the old hard-coded 30.
    for (let i = 0; i < 20; i += 1) {
      const email = `client${i}@example.com`;
      const code = await createEmailLoginCode(email, undefined);
      // A burned wrong guess first, then the correct code — no shared bucket trips.
      expect(await outcome(await action(verifyRequest(email, wrong(code))))).toBe(400);
      expect(await outcome(await action(verifyRequest(email, code)))).toBe('signed-in');
    }
    expect([...fake.store.keys()].some((k) => k.includes('otp-verify-ip'))).toBe(false);
  });

  it('the per-code attempt cap still holds without an IP: the correct code after the cap is refused', async () => {
    const email = 'victim@example.com';
    const code = await createEmailLoginCode(email, undefined);
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i += 1) {
      expect(await outcome(await action(verifyRequest(email, wrong(code))))).toBe(400);
    }
    expect(await outcome(await action(verifyRequest(email, code)))).toBe(400);
  });
});

describe('POST /login/verify — known client IP', () => {
  it('the per-IP limit (OTP_VERIFY_IP_LIMIT) trips with 429 for that IP only', async () => {
    vi.stubEnv('OTP_VERIFY_IP_LIMIT', '2');
    const a = { 'x-real-ip': '203.0.113.10' };
    const email = 'ip@example.com';
    const code = await createEmailLoginCode(email, '203.0.113.10');
    expect(await outcome(await action(verifyRequest(email, wrong(code), a)))).toBe(400);
    expect(await outcome(await action(verifyRequest(email, wrong(code), a)))).toBe(400);
    // Third check from the same IP: refused by the IP bucket even with the right code.
    expect(await outcome(await action(verifyRequest(email, code, a)))).toBe(429);
    // Another client IP is independent.
    expect(await outcome(await action(verifyRequest(email, code, { 'x-real-ip': '203.0.113.11' })))).toBe(
      'signed-in'
    );
  });

  it('a malformed X-Real-IP (TRUST_PROXY=x-real-ip) resolves to no IP — no bucket is written', async () => {
    const email = 'bad-ip@example.com';
    const code = await createEmailLoginCode(email, undefined);
    expect(await outcome(await action(verifyRequest(email, code, { 'x-real-ip': 'evil.example' })))).toBe(
      'signed-in'
    );
    expect([...fake.store.keys()].some((k) => k.includes('otp-verify-ip'))).toBe(false);
  });
});
