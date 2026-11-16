import { expect, test, type Page } from '@playwright/test';
import { APPS_URL_SCHEME } from '../playwright.config';
import { hostRequest, prodHost, previewHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { personalWorkspaceOf, publishVersion, seedApp, seedVersion } from './helpers/seed';

/**
 * A password change on a password-protected app ends existing access at once:
 * the app-access cookie is signed over a fingerprint of the stored password
 * hash, so after the owner saves a new password in the dashboard every cookie
 * issued under the old one gets the password page again, on every host of
 * the app, with the very next request — in a visitor's browser and over raw
 * HTTP. Saving the same password again, or public and back, ends them too
 * (every hash has a fresh salt). The app is SEEDED via SQL; the password is
 * changed through the real Settings form (which announces the change to the
 * serve cache).
 */

const ACCESS_NAME = APPS_URL_SCHEME === 'https' ? '__Host-drobek_app_access' : 'drobek_app_access';
const UNLOCK_PATH = '/__drobek/password';
const PAGE = '<!doctype html><html><head><title>Vault E2E</title><link rel="icon" href="data:,"></head><body><h1>vault contents</h1></body></html>';

/** POST the unlock form over raw HTTP; the access cookie (`name=value`) on success, null otherwise. */
async function unlock(host: string, password: string): Promise<string | null> {
  const r = await hostRequest(host, UNLOCK_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/' }).toString(),
  });
  if (r.status !== 303) return null;
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${ACCESS_NAME}=`));
  return set ? set.split(';')[0] : null;
}

async function statusWith(host: string, cookie: string): Promise<number> {
  return (await hostRequest(host, '/', { headers: { Cookie: cookie } })).status;
}

async function savePassword(page: Page, settings: string, password: string): Promise<void> {
  await page.goto(settings);
  await page.getByTestId('visibility-password').check();
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('visibility-save').click();
  await expect(page.getByTestId('settings-visibility-current')).toHaveText('password');
}

test('a new app password ends every earlier unlock at once, on every host and in the browser @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('access-revoke');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: PAGE }] });
  await publishVersion(app.id, v1.id);
  const prod = prodHost(app.slug);
  const preview = previewHost(app.slug);
  expect((await hostRequest(prod)).status).toBe(200);

  const settings = `/workspaces/${ws.slug}/apps/${app.slug}/settings`;
  await savePassword(page, settings, 'correct horse');
  await expect(page.getByTestId('visibility-unlock-hint')).toContainText('ends every earlier unlock');
  expect((await hostRequest(prod)).status).toBe(401);

  // A visitor unlocks in their own browser; a raw client unlocks too.
  const visitor = await browser.newContext();
  try {
    const tab = await visitor.newPage();
    expect((await tab.goto(urlOf(prod)))?.status()).toBe(401);
    await tab.locator('#drobek-app-password').fill('correct horse');
    await tab.getByRole('button', { name: 'Unlock' }).click();
    await expect(tab.getByRole('heading', { name: 'vault contents' })).toBeVisible();

    const old = await unlock(prod, 'correct horse');
    expect(old, 'the unlock sets the access cookie').toBeTruthy();
    expect(await statusWith(prod, old!)).toBe(200);
    expect(await statusWith(preview, old!)).toBe(200);

    // The owner saves a new password: every earlier grant is over with the next request.
    await savePassword(page, settings, 'battery staple');
    expect(await statusWith(prod, old!)).toBe(401);
    expect(await statusWith(preview, old!)).toBe(401);
    const reload = await tab.reload();
    expect(reload?.status()).toBe(401);
    await expect(tab.locator('#drobek-app-password')).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'vault contents' })).toHaveCount(0);

    // The old password no longer unlocks; the new one does, in the browser too.
    expect(await unlock(prod, 'correct horse')).toBeNull();
    const fresh = await unlock(prod, 'battery staple');
    expect(fresh).toBeTruthy();
    expect(await statusWith(prod, fresh!)).toBe(200);
    await tab.locator('#drobek-app-password').fill('battery staple');
    await tab.getByRole('button', { name: 'Unlock' }).click();
    await expect(tab.getByRole('heading', { name: 'vault contents' })).toBeVisible();

    // The same password saved again is a new hash: earlier cookies end as well.
    await savePassword(page, settings, 'battery staple');
    expect(await statusWith(prod, fresh!)).toBe(401);

    // Public and back to password (same password): earlier cookies stay ended.
    const again = await unlock(prod, 'battery staple');
    expect(again).toBeTruthy();
    await page.getByTestId('visibility-public').check();
    await page.getByTestId('visibility-save').click();
    await expect(page.getByTestId('settings-visibility-current')).toHaveText('public');
    expect((await hostRequest(prod)).status).toBe(200);
    await savePassword(page, settings, 'battery staple');
    expect(await statusWith(prod, again!)).toBe(401);
    expect(await unlock(prod, 'battery staple')).toBeTruthy();
  } finally {
    await visitor.close();
  }
});
