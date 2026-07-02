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
  await expect(page.getByRole('heading', { name: 'drobek' })).toBeVisible();
  await expect(page.getByRole('link', { name: '/healthz' })).toBeVisible();

  // Give hydration a beat to surface any mismatch errors.
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});
