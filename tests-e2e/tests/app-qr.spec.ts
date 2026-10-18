import { expect, test } from '@playwright/test';
import { prodHost, previewHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { personalWorkspaceOf, seedApp, seedVersion } from './helpers/seed';

/**
 * "Show QR" on the app page's Overview: the preview URL always has one; the
 * live address gets one after publish; a password app says the code opens
 * the password page first; version hosts (`--v<N>`) have none. The SVG
 * carries the encoded address in `data-url`.
 */

const HTML = '<!doctype html><html><head><title>QR</title><meta name="description" content="QR test."><link rel="icon" href="data:,"></head><body><h1>qr</h1></body></html>';

test('app page: Show QR for the preview, then the live address after publish; password note @local', async ({ page, request }) => {
  skipUnlessLocal();
  const email = uniqueEmail('app-qr');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  await seedVersion({ appId: app.id, files: [{ path: 'index.html', content: HTML }] });
  const overview = `/workspaces/${ws.slug}/apps/${app.slug}`;

  await page.goto(overview);
  const previewQr = page.locator('[data-testid="app-qr"][data-kind="preview"]');
  const liveQr = page.locator('[data-testid="app-qr"][data-kind="live"]');
  await expect(previewQr).toHaveCount(1);
  await expect(liveQr).toHaveCount(0);
  await expect(previewQr.getByTestId('app-qr-code')).toBeHidden();
  await previewQr.locator('summary').click();
  const previewCode = previewQr.getByTestId('app-qr-code');
  await expect(previewCode).toBeVisible();
  await expect(previewCode).toHaveAttribute('data-url', urlOf(previewHost(app.slug)));
  await expect(previewCode).toHaveAttribute('role', 'img');
  await expect(previewCode).toHaveAttribute('aria-label', /preview/);
  await expect(previewQr.getByTestId('app-qr-unpublished')).toHaveText('Publish to get a live address.');
  await expect(previewQr.getByTestId('app-qr-password')).toHaveCount(0);

  await page.locator('[data-testid="version-row"][data-version="1"]').getByTestId('publish-button').click();
  await expect(page.getByTestId('app-published-version')).toHaveText('v1');
  await expect(liveQr).toHaveCount(1);
  await liveQr.locator('summary').click();
  await expect(liveQr.getByTestId('app-qr-code')).toHaveAttribute('data-url', urlOf(prodHost(app.slug)));
  await expect(page.getByTestId('app-qr-unpublished')).toHaveCount(0);

  for (const url of await page.getByTestId('app-qr-code').evaluateAll((els) => els.map((e) => e.getAttribute('data-url') ?? ''))) {
    expect(url).not.toMatch(/--v\d+\./);
  }

  await page.goto(`${overview}/settings`);
  await page.getByTestId('visibility-password').check();
  await page.getByTestId('password-input').fill('correct horse');
  await page.getByTestId('visibility-save').click();
  await expect(page.getByTestId('settings-visibility-current')).toHaveText('password');

  await page.goto(overview);
  await liveQr.locator('summary').click();
  await expect(liveQr.getByTestId('app-qr-password')).toHaveText('Opens the password page first.');
  await previewQr.locator('summary').click();
  await expect(previewQr.getByTestId('app-qr-password')).toBeVisible();

  await page.goto(`${overview}/settings`);
  await expect(page.getByTestId('app-qr')).toHaveCount(0);
});
