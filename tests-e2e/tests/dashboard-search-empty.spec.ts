import { expect, test } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { personalWorkspaceOf, seedApp, withDb } from './helpers/seed';

/**
 * NSO-371 review: the workspace apps search folds accents and case like the
 * public gallery (`%` / `_` match literally) and offers "Clear filters" with
 * the count; the Forms tab of an app without forms says so and offers a
 * concrete agent prompt instead of "No submissions match."
 */
test('apps search ignores accents and case; empty Forms tab explains the next step @local', async ({ page, request }) => {
  skipUnlessLocal();
  const email = uniqueEmail('search');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const autumn = await seedApp({ workspaceId: ws.id });
  const other = await seedApp({ workspaceId: ws.id });
  await withDb((c) => c.query(`UPDATE apps SET name = $2 WHERE id = $1`, [autumn.id, 'Podzimní obloha']));
  await withDb((c) => c.query(`UPDATE apps SET name = $2 WHERE id = $1`, [other.id, 'Jarní 50% sleva']));

  const list = `/workspaces/${ws.slug}/apps`;
  const rows = page.locator('[data-testid="app-row"]');
  for (const q of ['podzimni', 'PODZIMNÍ', 'Podzimní'.normalize('NFD')]) {
    await page.goto(`${list}?q=${encodeURIComponent(q)}`);
    await expect(rows, q).toHaveCount(1);
    await expect(page.locator(`[data-testid="app-row"][data-app-slug="${autumn.slug}"]`)).toBeVisible();
    await expect(page.getByTestId('apps-filter-count')).toHaveText('1 of 2 apps');
  }
  await page.goto(`${list}?q=${encodeURIComponent('%')}`);
  await expect(page.locator(`[data-testid="app-row"][data-app-slug="${other.slug}"]`)).toBeVisible();
  await expect(rows).toHaveCount(1);

  await page.getByTestId('apps-filter-q').fill('_');
  await page.getByTestId('apps-filter-apply').click();
  await expect(page.getByTestId('apps-no-match')).toContainText('see all 2 apps');
  await page.getByTestId('apps-no-match-clear').click();
  await page.waitForURL((u) => u.pathname === list && u.search === '');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('apps-filter-count')).toHaveText('2 apps');

  await page.goto(`${list}/${autumn.slug}/forms`);
  await expect(page.getByTestId('forms-none')).toBeVisible();
  await expect(page.getByTestId('submissions-empty')).toHaveCount(0);
  await expect(page.getByTestId('forms-filter')).toHaveCount(0);
  await expect(page.getByTestId('forms-agent-prompt-text')).toContainText(`workspace "${ws.slug}"`);
  await expect(page.getByTestId('forms-agent-prompt-text')).toContainText(`app "${autumn.slug}"`);
});
