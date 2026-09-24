import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';

test('index page renders console-clean @smoke', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      problems.push(`console.error: ${msg.text()}`);
    }
  });

  const res = await page.goto('/');
  const redirected = res?.request().redirectedFrom();
  if (redirected) {
    // LANDING_URL is set (drobek.app → www.drobek.app): the dashboard's `/`
    // is a 301 to the operator's own website, which this suite does not own.
    expect((await redirected.response())?.status()).toBe(301);
    expect(new URL(page.url()).origin).not.toBe(new URL(BASE_URL_WEB).origin);
    return;
  }
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'drobek' })).toBeVisible();
  // NSO-331: the landing describes the cloud workspace and links the agent docs.
  await expect(page.getByText('A cloud workspace for agent-built web apps')).toBeVisible();
  await expect(page.getByRole('link', { name: '/llms.txt' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agent guide' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: '/healthz' })).toBeVisible();

  // Give hydration a beat to surface any mismatch errors.
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});
