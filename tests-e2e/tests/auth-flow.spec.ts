import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import {
  mailpitMessagesFor,
  pollLoginCode,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';

/**
 * E-mail magic-code auth end to end against the local compose stack —
 * request → mailpit (REST API) → code → session → /me; 5 wrong attempts
 * invalidate the code; the cooldown dedups resends; anonymous /me bounces to
 * /login; a full rate-limit counter left without an expiry (a crash between
 * the count and its expiry) gets its window back on the next attempt instead
 * of refusing the address for good.
 */

/** Run `fn` against the dev stack's Redis. */
async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6391', { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

test('full flow: request code → mailpit → verify → /me shows email → logout clears @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('flow');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/login\/verify/);

  const code = await pollLoginCode(request, email);
  expect(code).toMatch(/^\d{6}$/);

  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByTestId('me-start')).toContainText('Start building');
  await expect(page.getByTestId('me-mcp-url')).toHaveText(/^https?:\/\/.+\/mcp$/);

  // Logout clears the session…
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  // …so /me bounces back to /login.
  await page.goto('/me');
  await page.waitForURL(/\/login/);
});

test('5 wrong codes invalidate the record — the 6th attempt with the CORRECT code is rejected @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('wrong');

  const send = await request.post('/login', { form: { email } });
  expect(send.url()).toContain('/login/verify');

  const code = await pollLoginCode(request, email);
  const wrong = wrongCodeFor(code);
  // POST to the same URL the verify form uses (loader needs ?email=).
  const verifyUrl = `/login/verify?${new URLSearchParams({ email })}`;

  for (let i = 0; i < 5; i += 1) {
    const r = await request.post(verifyUrl, {
      form: { email, code: wrong },
    });
    expect(r.status()).toBe(400);
  }

  // 6th attempt with the CORRECT code must fail — the record is gone.
  const final = await request.post(verifyUrl, { form: { email, code } });
  expect(final.status()).toBe(400);
  const headerNames = final.headersArray().map((h) => h.name.toLowerCase());
  expect(headerNames).not.toContain('set-cookie');
});

test('immediate resend within the cooldown does not produce a second mailpit message @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('cooldown');

  const first = await request.post('/login', { form: { email } });
  expect(first.url()).toContain('/login/verify');
  await pollLoginCode(request, email); // first email landed

  // Resend inside the cooldown window → generic redirect, NOTHING new sent.
  const second = await request.post('/login', { form: { email } });
  expect(second.url()).toContain('/login/verify');

  // Give a would-be second send time to land, then assert exactly one message.
  await new Promise((r) => setTimeout(r, 1500));
  const msgs = await mailpitMessagesFor(request, email);
  expect(msgs.length).toBe(1);
});

test('a full per-address counter without an expiry gets its hour back on the next attempt @local', async ({ request }) => {
  skipUnlessLocal();
  const email = uniqueEmail('stuck');
  const key = `drobek:rl:otp-email-1h:${createHash('sha256').update(email.toLowerCase()).digest('hex')}`;
  await withRedis((r) => r.set(key, '1000000'));
  try {
    expect(await withRedis((r) => r.pttl(key))).toBe(-1);

    // Over the hourly share: the generic redirect, nothing sent…
    const res = await request.post('/login', { form: { email } });
    expect(res.url()).toContain('/login/verify');

    // …and the counter now ends with its hour instead of never.
    const ttl = await withRedis((r) => r.pttl(key));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await mailpitMessagesFor(request, email)).toEqual([]);
  } finally {
    await withRedis((r) => r.del(key));
  }
});

test('anonymous /me redirects to /login @local', async ({ page }) => {
  skipUnlessLocal();
  await page.goto('/me');
  await page.waitForURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
});
