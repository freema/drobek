import { randomInt } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { Redis } from 'ioredis';
import { TEST_ENV } from '../../playwright.config';

/**
 * Shared helpers for the auth specs (U2 auth-flow + U3 auth-google) — mailpit
 * polling, unique test addresses, @local gating. Not a spec file: Playwright's
 * testMatch never collects it.
 */

export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export function skipUnlessLocal(): void {
  test.skip(
    TEST_ENV !== 'local',
    'requires TEST_ENV=local (local compose stack + mailpit)'
  );
}

/** Unique self-cleaning address per run — never collides across reruns. */
export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

interface MailpitAddress {
  Address?: string;
}
export interface MailpitMessageMeta {
  ID: string;
  Subject?: string;
  To?: MailpitAddress[];
}

export async function mailpitMessagesFor(
  request: APIRequestContext,
  email: string
): Promise<MailpitMessageMeta[]> {
  const res = await request.get(`${MAILPIT_URL}/api/v1/messages?limit=200`);
  expect(res.ok(), 'mailpit REST API must be reachable').toBeTruthy();
  const body = (await res.json()) as { messages?: MailpitMessageMeta[] };
  return (body.messages ?? []).filter((m) =>
    (m.To ?? []).some((t) => t.Address?.toLowerCase() === email)
  );
}

export async function pollLoginCode(
  request: APIRequestContext,
  email: string,
  timeoutMs = 30_000,
  /** Message IDs to ignore — snapshot them BEFORE send-code when the address already received a code in this run. */
  skipIds: ReadonlySet<string> = new Set()
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = (await mailpitMessagesFor(request, email)).filter((m) => !skipIds.has(m.ID));
    if (msgs.length > 0) {
      const detail = await request.get(
        `${MAILPIT_URL}/api/v1/message/${msgs[0].ID}`
      );
      if (detail.ok()) {
        const d = (await detail.json()) as { Subject?: string; Text?: string };
        const m = /\b(\d{6})\b/.exec(`${d.Subject ?? ''}\n${d.Text ?? ''}`);
        if (m) return m[1];
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no login-code email for ${email} within ${timeoutMs}ms`);
}

const LOCAL_REDIS_HOSTS = ['localhost', '127.0.0.1', 'redis'];

/**
 * Drop one per-IP rate-limit family (`drobek:rl:<bucket>:*`). Local-only
 * (TEST_ENV=local + a local REDIS_URL, mirroring the global-setup guard); a
 * no-op anywhere else. Needed behind the e2e Caddy (`task e2e:image`, CI):
 * Caddy sets X-Real-IP from the TCP peer, so every request of the run comes
 * from ONE real client IP and would trip the low per-IP limits (DCR, forms,
 * abuse reports) mid-suite. On the plain-HTTP dev stack a request without an
 * X-Real-IP has no per-IP bucket at all (NSO-309/NSO-328) — there the resets
 * find nothing to drop. The OTP verify limit needs no reset: the compose files
 * relax OTP_VERIFY_IP_LIMIT.
 */
export async function resetRateLimitBucket(bucket: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || TEST_ENV !== 'local') return;
  if (!LOCAL_REDIS_HOSTS.includes(new URL(url).hostname)) return;
  const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    const keys = await redis.keys(`drobek:rl:${bucket}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

/**
 * /oauth/register allows 10 registrations per IP per hour (PHY-76 #7) and the
 * suite registers far more — behind Caddy all from the runner's one IP: drop
 * that bucket before each registration.
 */
export async function resetDcrIpRateLimit(): Promise<void> {
  await resetRateLimitBucket('oauth-register-ip');
}

/**
 * Headers giving a spec a client IP of its own, for a test that counts a
 * per-IP limit up to its 429 (NSO-328). On the plain-HTTP dev stack
 * (TRUST_PROXY unset) drobek honours a client-sent X-Real-IP, and a request
 * without one has NO per-IP bucket — the limit would never trip. A random
 * address from the IPv6 documentation prefix is shared with nobody, so no
 * reset is needed there. Behind Caddy (TRUST_PROXY=x-real-ip) Caddy replaces
 * the header with the runner's address, which is why those specs still call
 * resetRateLimitBucket first.
 */
export function ownClientIpHeaders(): Record<string, string> {
  return { 'X-Real-IP': `2001:db8::${randomInt(1, 0xffff).toString(16)}:${randomInt(1, 0xffff).toString(16)}` };
}

/** Full magic-code sign-in via the UI; leaves the page authenticated on /me. */
export async function loginViaEmail(
  page: Page,
  request: APIRequestContext,
  email: string
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/login\/verify/);
  const code = await pollLoginCode(request, email);
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);
}

/** Sign out the current session; leaves the page on the home route. */
export async function logout(page: Page): Promise<void> {
  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}
