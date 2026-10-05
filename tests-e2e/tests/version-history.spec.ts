import { expect, test } from '@playwright/test';
import { loginViaEmail, logout, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { setFakePlan } from './helpers/limits';
import { addMembership, personalWorkspaceOf, publishVersion, seedApp, seedVersion, userIdByEmail, withDb } from './helpers/seed';

/**
 * The version history of the app page against the local compose stack. An
 * app with 26 seeded versions (APP_VERSIONS_PAGE 20 by default): v3 is live,
 * v26 the preview, v20–v22 and v5–v7 failed builds, every version but v14
 * created three hours ago (so only v14 is "from the last hour").
 *  - Pinned lists the live and preview versions; the History page shows
 *    v26–v7 with v20–v22 collapsed into "3 failed builds"; "Show older
 *    versions" pages to v6–v1, where the run v5–v7 splits at the page edge;
 *    a cursor past the oldest says so and links back.
 *  - Keep / Unkeep with the fake plan's APP_VERSIONS_KEPT_MAX 1: the second
 *    keep answers the limit's message; an unkeep of a version past the newest
 *    APP_VERSIONS_KEEP says the hourly retention will delete it.
 *  - Clean up: the GET form opens the confirm panel (what goes, what stays
 *    and why), an unconfirmed POST deletes nothing, the panel's POST deletes
 *    and the result banner says what; the live, kept and last-hour versions
 *    survive; "only failed builds" deletes just those. Both clean-ups are
 *    Activity rows.
 *  - A viewer sees the badges but no Keep and no clean-up.
 */

const ERRORS = (n: number) => [{ file: 'src/App.tsx', line: n, column: 1, text: `Unexpected token in build ${n}` }];

async function storedNumbers(appId: string): Promise<number[]> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT number FROM app_versions WHERE app_id = $1 ORDER BY number`, [appId]);
    return res.rows.map((r) => Number(r.number));
  });
}

test('version history: pinned versions, paging, failed runs, keep / unkeep, clean-up @local', async ({ page, request }) => {
  skipUnlessLocal();
  test.setTimeout(240_000);
  const email = uniqueEmail('version-history');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  const failed = new Set([5, 6, 7, 20, 21, 22]);
  let v3Id = '';
  for (let n = 1; n <= 26; n++) {
    const v = await seedVersion({
      appId: app.id,
      files: [{ path: 'index.html', content: `<!doctype html><title>v${n}</title><h1>${n}</h1>` }],
      compileStatus: failed.has(n) ? 'error' : 'ok',
      ...(failed.has(n) ? { compileErrors: ERRORS(n) } : {}),
      reasoning: `Write ${n}`,
    });
    if (n === 3) v3Id = v.id;
  }
  await publishVersion(app.id, v3Id);
  await withDb((c) =>
    c.query(`UPDATE app_versions SET created_at = created_at - interval '3 hours' WHERE app_id = $1 AND number <> 14`, [app.id])
  );
  await setFakePlan(ws.id, { APP_VERSIONS_KEPT_MAX: 1 });
  const base = `/workspaces/${ws.slug}/apps/${app.slug}`;
  const row = (n: number) => page.locator(`[data-testid="version-row"][data-version="${n}"]`);
  const pinned = (n: number) => page.locator(`[data-testid="pinned-row"][data-version="${n}"]`);

  try {
    // ── Pinned + the first page ─────────────────────────────────────────────
    await page.goto(base);
    const pinnedRows = page.getByTestId('pinned-row');
    await expect(pinnedRows).toHaveCount(2);
    expect(await pinnedRows.evaluateAll((els) => els.map((e) => e.getAttribute('data-version')))).toEqual(['26', '3']);
    await expect(pinned(26).locator('[data-testid="pinned-badge"][data-kind="preview"]')).toBeVisible();
    await expect(pinned(3).locator('[data-testid="pinned-badge"][data-kind="live"]')).toBeVisible();

    await expect(page.getByTestId('version-page-range')).toHaveText('Showing v26–v7 of 26 versions.');
    // v26..v7 = 20 versions; v20–v22 are one collapsed row.
    await expect(page.getByTestId('version-row')).toHaveCount(17);
    await expect(row(26).getByTestId('version-preview')).toBeVisible();
    const run = page.locator('[data-testid="failed-run"][data-from="20"][data-to="22"]');
    await expect(run.getByTestId('failed-run-summary')).toHaveText('3 failed builds, v20–v22');
    const v21 = run.locator('[data-testid="failed-run-version"][data-version="21"]');
    await expect(v21).toBeHidden();
    await run.getByTestId('failed-run-summary').click();
    await expect(v21).toBeVisible();
    await expect(v21).toContainText('src/App.tsx:21:1 Unexpected token in build 21');
    // v7 is alone on this page: a plain row.
    await expect(row(7).getByTestId('version-compile')).toHaveAttribute('data-status', 'error');
    await expect(page.getByTestId('versions-newest')).toHaveCount(0);

    // ── Older versions: the run v5–v7 splits at the page edge ────────────────
    await page.getByTestId('versions-older').click();
    await page.waitForURL(/before=7$/);
    await expect(page.getByTestId('version-page-range')).toHaveText('Showing v6–v1 of 26 versions.');
    await expect(page.locator('[data-testid="failed-run"][data-from="5"][data-to="6"]')).toBeVisible();
    expect(await page.getByTestId('version-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-version')))).toEqual([
      '4',
      '3',
      '2',
      '1',
    ]);
    await expect(row(3).getByTestId('version-published')).toBeVisible();
    await expect(page.getByTestId('versions-older')).toHaveCount(0);
    await expect(page.getByTestId('pinned-row')).toHaveCount(2);

    await page.goto(`${base}?before=1`);
    await expect(page.getByTestId('versions-past-end')).toHaveText(/There are no versions older than v1\./);
    await page.getByTestId('versions-newest').click();
    await page.waitForURL((u) => u.pathname === base && u.search === '');
    await expect(row(26)).toBeVisible();

    // ── Keep / Unkeep under APP_VERSIONS_KEPT_MAX 1 ──────────────────────────
    await row(12).getByTestId('keep-button').click();
    await expect(page.locator('[data-testid="version-result"][data-kind="kept"]')).toContainText('v12 is kept');
    await expect(pinned(12).locator('[data-testid="pinned-badge"][data-kind="kept"]')).toBeVisible();
    await expect(row(12).getByTestId('version-kept')).toBeVisible();
    await expect(row(12).getByTestId('keep-button')).toHaveText('Unkeep');

    await row(13).getByTestId('keep-button').click();
    const capped = page.locator('[data-testid="action-error"][data-intent="keep"]');
    await expect(capped).toContainText('APP_VERSIONS_KEPT_MAX');
    await expect(capped).toContainText('Stop keeping a version');
    await expect(row(13).getByTestId('version-kept')).toHaveCount(0);

    // An unkeep past the newest APP_VERSIONS_KEEP: the hourly retention will delete it.
    await setFakePlan(ws.id, { APP_VERSIONS_KEPT_MAX: 1, APP_VERSIONS_KEEP: 5 });
    try {
      await pinned(12).getByTestId('keep-button').click();
      const note = page.locator('[data-testid="version-result"][data-kind="unkept"]');
      await expect(note).toHaveAttribute('data-prunable', 'true');
      await expect(note).toContainText('the hourly history retention will delete it');
      await expect(pinned(12)).toHaveCount(0);
    } finally {
      await setFakePlan(ws.id, { APP_VERSIONS_KEPT_MAX: 1 });
    }
    await row(12).getByTestId('keep-button').click();
    await expect(pinned(12)).toBeVisible();

    // ── Clean up to v15: the confirm panel says what goes and what stays ─────
    await page.getByTestId('cleanup-up-to').fill('15');
    await page.getByTestId('cleanup-review').click();
    await page.waitForURL(/cleanup=15/);
    const confirm = page.getByTestId('cleanup-confirm');
    await expect(confirm).toHaveAttribute('data-count', '12');
    await expect(page.getByTestId('cleanup-summary')).toHaveText(
      '12 versions will be deleted for good (v1–v2, v4–v11, v13, v15); 3 stay because they are live / kept / from the last hour.'
    );
    expect(await page.getByTestId('cleanup-stays').evaluateAll((els) => els.map((e) => e.getAttribute('data-reason')))).toEqual([
      'published',
      'kept',
      'recent',
    ]);

    // Without the panel's confirmation nothing is deleted.
    const unconfirmed = await page.request.post(base, { form: { intent: 'delete-versions', upTo: '15' } });
    expect(unconfirmed.status()).toBe(400);
    expect(await storedNumbers(app.id)).toHaveLength(26);

    await page.getByTestId('cleanup-confirm-submit').click();
    await page.waitForURL(/deletedCount=12/);
    await expect(page.getByTestId('cleanup-confirm')).toHaveCount(0);
    await expect(page.locator('[data-testid="version-result"][data-kind="deleted"]')).toContainText(
      'Deleted 12 versions for good (v1–v2, v4–v11, v13, v15)'
    );
    expect(await storedNumbers(app.id)).toEqual([3, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    await expect(pinned(3)).toBeVisible();
    await expect(pinned(12)).toBeVisible();
    await expect(page.getByTestId('version-retention')).toContainText('14 versions are stored now, the oldest is v3');

    // ── Only the failed builds ───────────────────────────────────────────────
    await page.getByTestId('cleanup-up-to').fill('26');
    await page.getByTestId('cleanup-failed-only').check();
    await page.getByTestId('cleanup-review').click();
    await page.waitForURL(/cleanup=26&failedOnly=1/);
    await expect(page.getByTestId('cleanup-confirm')).toHaveAttribute('data-count', '3');
    await page.getByTestId('cleanup-confirm-submit').click();
    await page.waitForURL(/deletedFailedOnly=1/);
    await expect(page.locator('[data-testid="version-result"][data-kind="deleted"]')).toContainText(
      'Deleted 3 failed builds for good (v20–v22)'
    );
    expect(await storedNumbers(app.id)).toEqual([3, 12, 14, 16, 17, 18, 19, 23, 24, 25, 26]);
    await expect(page.getByTestId('failed-run')).toHaveCount(0);

    // ── Activity ─────────────────────────────────────────────────────────────
    await page.goto(`/workspaces/${ws.slug}/activity?app=${app.slug}&action=app.versions.delete`);
    const activity = page.locator('[data-testid="activity-row"][data-action="app.versions.delete"]');
    await expect(activity).toHaveCount(2);
    await expect(activity.nth(0).getByTestId('activity-summary')).toContainText('Deleted 3 failed builds (versions 20–22)');
    await expect(activity.nth(1).getByTestId('activity-summary')).toContainText('Deleted 12 old versions (versions 1–15)');
    for (const r of await activity.all()) await expect(r.getByTestId('activity-actor')).toContainText(email);

    // ── A viewer: badges, no Keep, no clean-up ───────────────────────────────
    const viewerEmail = uniqueEmail('version-history-viewer');
    await logout(page);
    await loginViaEmail(page, request, viewerEmail);
    await addMembership(await userIdByEmail(viewerEmail), ws.id, 'viewer');
    await page.goto(base);
    await expect(pinned(12).locator('[data-testid="pinned-badge"][data-kind="kept"]')).toBeVisible();
    await expect(page.getByTestId('keep-button')).toHaveCount(0);
    await expect(page.getByTestId('cleanup-section')).toHaveCount(0);
    const refused = await page.request.post(base, { form: { intent: 'unkeep', version: '12' } });
    expect(refused.status()).toBe(403);
    const forced = await page.request.post(base, { form: { intent: 'delete-versions', upTo: '20', confirmed: '1' } });
    expect(forced.status()).toBe(403);
    expect(await storedNumbers(app.id)).toHaveLength(11);
  } finally {
    await setFakePlan(ws.id, null);
  }
});

test('an app without versions says the agent writes the first one; an unknown app explains itself @local', async ({ page, request }) => {
  skipUnlessLocal();
  const email = uniqueEmail('version-history-empty');
  await loginViaEmail(page, request, email);
  const ws = await personalWorkspaceOf(email);
  const app = await seedApp({ workspaceId: ws.id });
  await page.goto(`/workspaces/${ws.slug}/apps/${app.slug}`);
  await expect(page.getByTestId('versions-empty')).toHaveText('No versions yet — your agent writes the first one.');
  await expect(page.getByTestId('cleanup-section')).toHaveCount(0);
  await expect(page.getByTestId('pinned-row')).toHaveCount(0);

  const missing = await page.goto(`/workspaces/${ws.slug}/apps/${app.slug}-gone`);
  expect(missing?.status()).toBe(404);
  await expect(page.getByTestId('app-page-error')).toHaveAttribute('data-status', '404');
});
