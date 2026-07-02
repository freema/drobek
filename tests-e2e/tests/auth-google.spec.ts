import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { TEST_ENV } from '../playwright.config';
import { pollLoginCode, skipUnlessLocal, uniqueEmail } from './helpers/auth';

/**
 * U3 acceptance (PHY-53): Google OIDC login, account-link by email — driven
 * entirely by the mock provider (tests-e2e/mock-google.mjs). The web container
 * reaches the mock's /token + /userinfo via host.docker.internal:3049; the
 * browser opens /authorize on localhost:3049 (see docker-compose.yml env).
 *
 * The suite is self-contained: it spawns the mock itself and kills it in
 * afterAll — unless one is ALREADY listening (`task mock:google`), in which
 * case it reuses that instance and leaves it running.
 */

const MOCK_PORT = Number(process.env.MOCK_GOOGLE_PORT ?? 3049);
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_SCRIPT = fileURLToPath(
  new URL('../mock-google.mjs', import.meta.url)
);

let spawnedMock: ChildProcess | null = null;

async function mockIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_URL}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  if (TEST_ENV !== 'local') return;
  if (await mockIsUp()) return; // reuse an operator-started mock (task mock:google)

  spawnedMock = spawn(process.execPath, [MOCK_SCRIPT], {
    env: { ...process.env, MOCK_GOOGLE_PORT: String(MOCK_PORT) },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await mockIsUp()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mock-google did not become ready on ${MOCK_URL}`);
});

test.afterAll(() => {
  spawnedMock?.kill();
  spawnedMock = null;
});

/** /login → Continue with Google → mock consent (fill identity) → Approve. */
async function runGoogleConsentFlow(
  page: import('@playwright/test').Page,
  identity: { email: string; emailVerified?: boolean; sub?: string }
): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.waitForURL(new RegExp(`localhost:${MOCK_PORT}/authorize`));
  await page.getByLabel('Google email').fill(identity.email);
  if (identity.emailVerified === false) {
    await page.getByLabel('Email verified').fill('0');
  }
  if (identity.sub) {
    await page.getByLabel('Google sub').fill(identity.sub);
  }
  await page.getByRole('button', { name: 'Approve' }).click();
}

test('new user: consent → authed, /me shows the canned email @local', async ({
  page,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('google-new');

  await runGoogleConsentFlow(page, { email });
  await page.waitForURL(/\/me$/);
  await expect(page.getByText(email)).toBeVisible();
});

test('account link: google login with a magic-code email reuses the SAME user row @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('google-link');

  // 1) Create the user via the U2 magic-code flow.
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.waitForURL(/\/login\/verify/);
  const code = await pollLoginCode(request, email);
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);

  // 2) Logout.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/');

  // 3) Google flow with the SAME canned email → must land on the same account.
  await runGoogleConsentFlow(page, { email });
  await page.waitForURL(/\/me$/);
  await expect(page.getByText(email)).toBeVisible();

  // 4) The acceptance: exactly ONE users row for the email, google_sub set.
  const dbUrl = process.env.DATABASE_URL;
  expect(dbUrl, 'DATABASE_URL must be set for the DB assert').toBeTruthy();
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT id, google_sub FROM users WHERE email = $1',
      [email]
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].google_sub).toBeTruthy();
  } finally {
    await client.end();
  }
});

test('tampered state is rejected: no session cookie, bounced to /login?error=google @local', async ({
  request,
}) => {
  skipUnlessLocal();

  // Start the flow so the request context holds a REAL state cookie…
  const start = await request.get('/auth/google', { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  expect(start.headers()['location']).toContain('/authorize');

  // …then call back with a DIFFERENT (well-formed) state.
  const cb = await request.get(
    `/auth/google/callback?code=some-code&state=${'a'.repeat(48)}`,
    { maxRedirects: 0 }
  );
  expect(cb.status()).toBe(302);
  expect(cb.headers()['location']).toBe('/login?error=google');
  const setCookies = cb
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie');
  expect(
    setCookies.some((h) => h.value.trim().startsWith('drobek_session=')),
    'a rejected callback must never set a session cookie'
  ).toBe(false);
});

test('missing state is rejected: no session cookie @local', async ({
  request,
}) => {
  skipUnlessLocal();
  const cb = await request.get('/auth/google/callback?code=some-code', {
    maxRedirects: 0,
  });
  expect(cb.status()).toBe(302);
  expect(cb.headers()['location']).toBe('/login?error=google');
  const setCookies = cb
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie');
  expect(
    setCookies.some((h) => h.value.trim().startsWith('drobek_session='))
  ).toBe(false);
});

test('email_verified=false is rejected: generic error on /login, no session @local', async ({
  page,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('google-unverified');

  await runGoogleConsentFlow(page, { email, emailVerified: false });
  await page.waitForURL(/\/login\?error=google/);
  await expect(page.getByRole('alert')).toContainText(
    'Google sign-in did not complete'
  );

  // No session was created — /me still bounces to /login.
  await page.goto('/me');
  await page.waitForURL(/\/login/);
});
