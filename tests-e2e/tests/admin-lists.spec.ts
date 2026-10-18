import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { loginViaEmail, skipUnlessLocal } from './helpers/auth';
import { withDb } from './helpers/seed';

/**
 * The super-admin lists search, filter, sort and page on the server:
 *  - All workspaces (`/workspaces`): `?q=` by an admin's e-mail shows only
 *    that workspace; the kind chips; sort by name; each row says when it was
 *    created, its members and its last activity; more workspaces than
 *    ADMIN_LIST_PAGE (default 50) are split into pages with "Showing a–b of n";
 *  - `/admin/abuse?q=<host>` and `/admin/publishing?q=<slug>` find one row.
 * Every row is seeded through SQL under a unique tag, so the searches only
 * see this run's rows. The super-admin is `e2e-superadmin@drobek.test`.
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const SEEDED = 56;

const newId = (prefix: string) => `${prefix}${randomBytes(12).toString('hex')}`;

interface Seed {
  tag: string;
  ownerEmail: string;
  personalSlug: string;
  busySlug: string;
  reportHost: string;
}

async function seed(): Promise<Seed> {
  const tag = `al${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const ownerEmail = `${tag}-owner@drobek.test`;
  const personalSlug = `${tag}-personal`;
  const busySlug = `${tag}-busy`;
  const reportHost = `${tag}-reported.example.net`;
  await withDb(async (c) => {
    const ownerId = newId('usr');
    const memberId = newId('usr');
    await c.query(`INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`, [ownerId, ownerEmail, memberId, `${tag}-member@drobek.test`]);
    const personalId = newId('ws');
    await c.query(`INSERT INTO workspaces (id, kind, slug, name, created_at) VALUES ($1, 'personal', $2, 'Personal', now() - interval '3 days')`, [
      personalId,
      personalSlug,
    ]);
    await c.query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'workspace-admin')`, [ownerId, personalId]);
    for (let i = 0; i < SEEDED - 1; i++) {
      const id = newId('ws');
      const slug = i === 0 ? busySlug : `${tag}-team-${String(i).padStart(2, '0')}`;
      await c.query(`INSERT INTO workspaces (id, kind, slug, name, created_at) VALUES ($1, 'team', $2, $3, now() - make_interval(mins => $4))`, [
        id,
        slug,
        `${tag} ${String.fromCharCode(97 + (i % 26))} team ${i}`,
        i,
      ]);
      await c.query(`INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, 'workspace-admin')`, [memberId, id]);
      if (i === 0) {
        const appId = newId('app');
        await c.query(`INSERT INTO apps (id, workspace_id, slug) VALUES ($1, $2, $3)`, [appId, id, `${tag}-app`]);
        await c.query(
          `INSERT INTO app_versions (id, app_id, number, compile_status, actor_kind) VALUES ($1, $2, 1, 'ok', 'agent')`,
          [newId('ver'), appId]
        );
      }
    }
    await c.query(`INSERT INTO abuse_reports (id, host, reason, details) VALUES ($1, $2, 'spam', 'seeded by the admin lists spec')`, [
      newId('rep'),
      reportHost,
    ]);
  });
  return { tag, ownerEmail, personalSlug, busySlug, reportHost };
}

const rows = (page: Page) => page.getByTestId('all-workspace-item');

test('admin lists: All workspaces searches, filters, sorts and pages on the server; abuse and publishing search @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const s = await seed();
  await loginViaEmail(page, request, SUPER_ADMIN);

  // Search by the owner's e-mail → only their workspace.
  await page.goto('/workspaces');
  await page.getByTestId('all-workspaces-filter-q').fill(s.ownerEmail);
  await page.getByTestId('all-workspaces-filter-apply').click();
  await page.waitForURL((u) => u.searchParams.get('q') === s.ownerEmail);
  await expect(rows(page)).toHaveCount(1);
  const personal = page.locator(`[data-testid="all-workspace-item"][data-slug="${s.personalSlug}"]`);
  await expect(personal.getByTestId('workspace-owner')).toHaveText(`owner ${s.ownerEmail}`);
  await expect(personal.getByTestId('workspace-created')).toHaveText('created 3 days ago');
  await expect(personal.getByTestId('workspace-created')).toHaveAttribute('title', / UTC$/);
  await expect(personal.getByTestId('workspace-members')).toHaveText('1 member');
  await expect(personal.getByTestId('workspace-last-activity')).toHaveText(/^last activity (just now|\d+ min ago)$/);
  await expect(page.getByTestId('all-workspaces-count')).toContainText('· 1 matches');

  // The tag matches every seeded workspace: counts, then the kind chips.
  await page.goto(`/workspaces?q=${s.tag}`);
  await expect(page.getByTestId('all-workspaces-count')).toHaveAttribute('data-matching', String(SEEDED));
  await page.locator('[data-testid="admin-chip"][data-param="kind"][data-value="personal"]').click();
  await expect(page).toHaveURL(/kind=personal/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-slug', s.personalSlug);
  await page.locator('[data-testid="admin-chip"][data-param="kind"][data-value="team"]').click();
  await expect(page.getByTestId('all-workspaces-count')).toHaveAttribute('data-matching', String(SEEDED - 1));
  await expect(page.locator(`[data-testid="all-workspace-item"][data-slug="${s.personalSlug}"]`)).toHaveCount(0);

  // The busy workspace: an app, a version, so a last activity from its version.
  const busy = page.locator(`[data-testid="all-workspace-item"][data-slug="${s.busySlug}"]`);
  await page.goto(`/workspaces?q=${s.busySlug}`);
  await expect(busy.getByTestId('workspace-app-count')).toHaveText('1 app · 0 published');
  await expect(busy.getByTestId('workspace-members')).toHaveText('1 member');
  await expect(busy.getByTestId('workspace-last-activity')).toHaveText(/^last activity (just now|\d+ min ago)$/);

  // Sort by name.
  await page.goto(`/workspaces?q=${s.tag}&kind=team`);
  await page.getByTestId('all-workspaces-filter-sort').selectOption('name');
  await page.getByTestId('all-workspaces-filter-apply').click();
  await expect(page).toHaveURL(/sort=name/);
  const shown = await rows(page).evaluateAll((els) => els.map((e) => e.querySelector('a')?.textContent ?? ''));
  expect(shown.length).toBeGreaterThan(1);
  expect(shown).toEqual([...shown].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')));

  // Pages: more matches than one page holds.
  await page.goto(`/workspaces?q=${s.tag}`);
  const pager = page.getByTestId('all-workspaces-pager');
  await expect(pager).toBeVisible();
  const perPage = await rows(page).count();
  expect(perPage).toBeLessThan(SEEDED);
  await expect(page.getByTestId('all-workspaces-pager-range')).toHaveText(`Showing 1–${perPage} of ${SEEDED}`);
  await page.getByTestId('all-workspaces-pager-next').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId('all-workspaces-pager-range')).toContainText(`Showing ${perPage + 1}–`);
  const second = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-slug')));
  expect(second.length).toBeGreaterThan(0);
  const pages = Math.ceil(SEEDED / perPage);
  await page.goto(`/workspaces?q=${s.tag}&page=999`);
  await expect(pager).toHaveAttribute('data-page', String(pages));
  await expect(pager).toHaveAttribute('data-pages', String(pages));

  // No match and its own sentence.
  await page.goto(`/workspaces?q=${s.tag}-nothing`);
  await expect(page.getByTestId('all-workspaces-none')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  // /admin/abuse?q=<host>
  await page.goto(`/admin/abuse?q=${s.reportHost}`);
  await expect(page.getByTestId('abuse-report')).toHaveCount(1);
  await expect(page.getByTestId('abuse-report').first()).toHaveAttribute('data-host', s.reportHost);
  await expect(page.getByTestId('abuse-created')).toHaveText(/^reported (just now|\d+ min ago)$/);
  await page.locator('[data-testid="admin-chip"][data-param="app"][data-value="present"]').click();
  await expect(page.getByTestId('abuse-none')).toBeVisible();

  // /admin/publishing?q=<slug>
  await page.goto(`/admin/publishing?state=all&q=${s.busySlug}`);
  await expect(page.getByTestId('publishing-workspace')).toHaveCount(1);
  await expect(page.getByTestId('publishing-workspace').first()).toHaveAttribute('data-slug', s.busySlug);
  await expect(page.getByTestId('publishing-count')).toHaveAttribute('data-matching', '1');
});
