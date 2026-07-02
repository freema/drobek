import { expect, test } from '@playwright/test';

/** Read-only @smoke — safe against any target, prod included. */
test('login page renders an email form console-clean @smoke', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      problems.push(`console.error: ${msg.text()}`);
    }
  });

  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();

  // Give hydration a beat to surface any mismatch errors.
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});
