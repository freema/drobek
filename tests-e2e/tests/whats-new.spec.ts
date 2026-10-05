import { expect, test } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';

const RELEASE_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

async function runningVersion(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get('/api/version');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { version: string }).version;
}

test('/whats-new redirects to the release notes of the running version @smoke', async ({ request }) => {
  const version = await runningVersion(request);
  const res = await request.get('/whats-new', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const location = res.headers()['location'] ?? '';
  if (RELEASE_RE.test(version)) {
    const tag = version.startsWith('v') ? version : `v${version}`;
    expect(location.endsWith(`/releases/tag/${encodeURIComponent(tag)}`)).toBe(true);
  } else {
    expect(location).toMatch(/\/releases$/);
  }
});

test('a signed-in person sees the notice once per release line @local', async ({ page, request }) => {
  skipUnlessLocal();
  const version = await runningVersion(request);
  await loginViaEmail(page, request, uniqueEmail('whats-new'));
  await page.goto('/workspaces');

  if (!RELEASE_RE.test(version)) {
    // A dev build (the usual dev stack) has no release line: no notice at all.
    await expect(page.getByTestId('whats-new-banner')).toHaveCount(0);
    return;
  }

  const banner = page.getByTestId('whats-new-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('drobek was updated to');
  await expect(banner.getByRole('link', { name: "What's new" })).toHaveAttribute('href', '/whats-new');

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForURL(/\/workspaces$/);
  await expect(page.getByTestId('whats-new-banner')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('whats-new-banner')).toHaveCount(0);
});

test('a signed-out visitor never sees the notice @local', async ({ page }) => {
  skipUnlessLocal();
  await page.goto('/login');
  await expect(page.getByTestId('whats-new-banner')).toHaveCount(0);
});
