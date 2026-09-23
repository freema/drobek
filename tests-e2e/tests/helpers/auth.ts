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
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await mailpitMessagesFor(request, email);
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
 * no-op anywhere else. Behind the e2e Caddy every request comes from ONE client
 * IP, so a full run would trip the low per-IP limits (DCR, forms) mid-suite.
 * The OTP verify limit needs no reset (NSO-309): without a client IP there is
 * no bucket, and the compose files relax OTP_VERIFY_IP_LIMIT.
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
 * suite registers far more: drop that bucket before each registration.
 */
export async function resetDcrIpRateLimit(): Promise<void> {
  await resetRateLimitBucket('oauth-register-ip');
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
