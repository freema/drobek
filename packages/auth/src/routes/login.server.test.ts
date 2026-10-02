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

vi.mock('../session.server.js', () => ({
  getSessionUser: vi.fn(async () => null),
}));

import type { ActionFunctionArgs } from 'react-router';
import { createHash } from 'node:crypto';
import { consumeEmailLoginCode } from '../email-code.server.js';
import { action } from './login.server.js';

const IP = '203.0.113.9';
const SEND_FAILED = 'We could not send the email. Please try again in a moment.';

/** The Resend API as the operator's transport: down for `failures` sends, then up; delivered texts land in `outbox`. */
function transport(failures: number): { outbox: string[] } {
  const outbox: string[] = [];
  let down = failures;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (down > 0) {
        down -= 1;
        throw new TypeError('fetch failed');
      }
      outbox.push((JSON.parse(String(init.body)) as { text: string }).text);
      return new Response(JSON.stringify({ id: `msg_${outbox.length}` }), { status: 200 });
    })
  );
  return { outbox };
}

function loginRequest(email: string): ActionFunctionArgs {
  const request = new Request('http://localhost/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': IP },
    body: new URLSearchParams({ email }).toString(),
  });
  return { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
}

/** The redirect target, or the HTTP status and message of the form error. */
async function submit(email: string): Promise<{ redirect: string } | { status: number; error: string }> {
  try {
    const res = (await action(loginRequest(email))) as { data: { error: string }; init: { status: number } };
    return { status: res.init.status, error: res.data.error };
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(302);
    return { redirect: thrown.headers.get('location') ?? '' };
  }
}

const emailHash = (e: string) => createHash('sha256').update(e).digest('hex');

beforeEach(() => {
  fake = new FakeRedis();
  vi.stubEnv('TRUST_PROXY', 'x-real-ip');
  vi.stubEnv('EMAIL_TRANSPORT', 'resend');
  vi.stubEnv('RESEND_API_KEY', 're_test_fake_login_0123');
  vi.stubEnv('EMAIL_FROM', 'drobek <no-reply@drobek.app>');
  for (const name of ['OTP_IP_SHORT_LIMIT', 'OTP_IP_DAILY_LIMIT', 'OTP_EMAIL_HOURLY_LIMIT', 'OTP_EMAIL_COOLDOWN_MS', 'OTP_GLOBAL_HOURLY_MAX', 'OTP_LOGIN_DISABLED']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /login — a mail outage (production defaults: 3 codes per address an hour, 5 attempts per IP in 15 min)', () => {
  it('failed sends do not use up the address: after 4 failures the mail is back, the next attempt sends a code that signs in', async () => {
    const email = 'ana@example.com';
    const mail = transport(4);
    for (let i = 0; i < 4; i += 1) {
      expect(await submit(email)).toEqual({ status: 502, error: SEND_FAILED });
    }
    expect(mail.outbox).toEqual([]);
    expect(await fake.get(`drobek:rl:otp-email-1h:${emailHash(email)}`)).toBeNull();
    expect(await fake.get('drobek:rl:otp-global-1h:all')).toBeNull();

    expect(await submit(email)).toEqual({ redirect: `/login/verify?${new URLSearchParams({ email })}` });
    expect(mail.outbox).toHaveLength(1);
    const code = /\b(\d{6})\b/.exec(mail.outbox[0])![1];
    expect(await consumeEmailLoginCode(email, code)).toEqual({ ok: true });
    // The one code that went out is charged once; the IP counted every attempt.
    expect(await fake.get(`drobek:rl:otp-email-1h:${emailHash(email)}`)).toBe('1');
    expect(await fake.get('drobek:rl:otp-global-1h:all')).toBe('1');
    expect(await fake.get(`drobek:rl:otp-ip-15m:${IP}`)).toBe('5');
  });

  it('the per-IP limit still counts failed attempts: the sixth attempt from one IP is refused', async () => {
    const mail = transport(5);
    for (let i = 0; i < 5; i += 1) {
      expect(await submit(`u${i}@example.com`)).toEqual({ status: 502, error: SEND_FAILED });
    }
    expect(await submit('u9@example.com')).toEqual({ status: 429, error: 'Too many attempts from this network. Please try again later.' });
    expect(mail.outbox).toEqual([]);
  });

  it('a delivered code still counts against the address: the fourth within the hour sends nothing new', async () => {
    vi.stubEnv('OTP_EMAIL_COOLDOWN_MS', '1');
    const email = 'eva@example.com';
    const mail = transport(0);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
      expect(await submit(email)).toEqual({ redirect: `/login/verify?${new URLSearchParams({ email })}` });
    }
    await new Promise((r) => setTimeout(r, 2));
    expect(await submit(email)).toEqual({ redirect: `/login/verify?${new URLSearchParams({ email })}` });
    expect(mail.outbox).toHaveLength(3);
  });
});
