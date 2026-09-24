import { expect, test } from '@playwright/test';

test('index page renders console-clean @smoke', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      problems.push(`console.error: ${msg.text()}`);
    }
  });

  const res = await page.goto('/');
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
