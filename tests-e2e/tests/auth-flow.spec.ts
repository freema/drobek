import { expect, test } from '@playwright/test';
import {
  mailpitMessagesFor,
  pollLoginCode,
  skipUnlessLocal,
  uniqueEmail,
} from './helpers/auth';

/**
 * U2 acceptance (PHY-53): email magic-code auth end-to-end against the local
 * compose stack — request → mailpit (REST API) → code → session → /me;
 * 5 wrong attempts invalidate the code; the cooldown dedups resends;
 * anonymous /me bounces to /login. (Shared mailpit helpers live in
 * helpers/auth.ts since U3 reuses them.)
 */

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

test('anonymous /me redirects to /login @local', async ({ page }) => {
  skipUnlessLocal();
  await page.goto('/me');
  await page.waitForURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
});
