import { expect, test, type Locator, type Page } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { DASHBOARD_ORIGIN, hostRequest, prodHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { personalWorkspaceOf, publishVersion, seedApp, seedVersion, withDb } from './helpers/seed';

/**
 * NSO-342 acceptance — one dashboard layout:
 *   (1) every workspace and app page has the breadcrumb
 *       `Workspaces › <workspace> › <app> › <section>` (each part a link
 *       except the last), and no "← back" links;
 *   (2) the app header and its tabs show on EVERY app sub-page, including
 *       Modules and the module detail page; the content width is the same on
 *       every page;
 *   (3) filter rows line up: inputs, selects, buttons and the Clear / Export
 *       CSV links share one height (the app list and the Activity filters);
 *   (4) the app list shows a sandboxed, inert iframe thumbnail of a public app
 *       (the app host allows exactly the dashboard origin to frame it) and a
 *       placeholder for a password-gated or never-compiled one;
 *   (5) the footer: `drobek <version> · <sha> · Source (AGPL-3.0) [· ★ n]`;
 *   (6) no horizontal scroll at 390 px.
 */

const HTML = (text: string) => `<!doctype html><html><head><title>${text}</title></head><body><h1>${text}</h1></body></html>`;

async function crumbs(page: Page): Promise<{ label: string; href: string | null; current: boolean }[]> {
  return page.locator('[data-testid="breadcrumb-item"]').evaluateAll((items) =>
    items.map((li) => {
      const a = li.querySelector('a');
      const current = li.querySelector('[aria-current="page"]');
      return {
        label: (a ?? current ?? li).textContent?.replace('›', '').trim() ?? '',
        href: a ? a.getAttribute('href') : null,
        current: current !== null,
      };
    })
  );
}

async function height(l: Locator): Promise<number> {
  const box = await l.boundingBox();
  expect(box, 'element is laid out').not.toBeNull();
  return Math.round((box as { height: number }).height);
}

/** Every control of a filter row: one height, one vertical centre. */
async function expectAligned(controls: Locator[]): Promise<void> {
  const boxes = await Promise.all(controls.map(async (c) => (await c.boundingBox()) as { y: number; height: number }));
  const heights = boxes.map((b) => Math.round(b.height));
  expect(new Set(heights).size, `heights ${heights.join(', ')}`).toBe(1);
  const centres = boxes.map((b) => Math.round(b.y + b.height / 2));
  expect(Math.max(...centres) - Math.min(...centres), `centres ${centres.join(', ')}`).toBeLessThanOrEqual(1);
}

async function mainWidth(page: Page): Promise<number> {
  return page.locator('main').evaluate((m) => Math.round(m.getBoundingClientRect().width));
}

test('one layout: breadcrumb, app header + tabs on every app page, aligned filters, thumbnails, footer @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const email = uniqueEmail('layout');
  await loginViaEmail(page, request, email);
  await page.waitForLoadState('networkidle');
  const ws = await personalWorkspaceOf(email);
  const wsName = await withDb(async (c) => (await c.query(`SELECT name FROM workspaces WHERE id = $1`, [ws.id])).rows[0].name as string);

  const live = await seedApp({ workspaceId: ws.id });
  const v1 = await seedVersion({ appId: live.id, files: [{ path: 'index.html', content: HTML('Thumbnail marker') }] });
  await publishVersion(live.id, v1.id);
  const locked = await seedApp({ workspaceId: ws.id });
  await seedVersion({ appId: locked.id, files: [{ path: 'index.html', content: HTML('secret') }] });
  await withDb((c) => c.query(`UPDATE apps SET visibility = 'password' WHERE id = $1`, [locked.id]));
  const empty = await seedApp({ workspaceId: ws.id });

  // ── (4) the app host lets exactly the dashboard frame it ───────────────────
  const csp = String((await hostRequest(prodHost(live.slug))).headers['content-security-policy']);
  expect(csp).toContain(`frame-ancestors ${DASHBOARD_ORIGIN};`);

  // ── the apps list: breadcrumb, workspace tabs, filters, thumbnails ─────────
  await page.goto(`/workspaces/${ws.slug}/apps`);
  expect(await crumbs(page)).toEqual([
    { label: 'Workspaces', href: '/workspaces', current: false },
    { label: wsName, href: null, current: true },
  ]);
  await expect(page.locator('[data-testid="workspace-tab"][data-tab="apps"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('my-role')).toHaveText('workspace-admin');
  const listWidth = await mainWidth(page);

  await expectAligned([
    page.getByTestId('apps-filter-q'),
    page.getByTestId('apps-filter-status'),
    page.getByTestId('apps-filter-sort'),
    page.getByTestId('apps-filter-apply'),
  ]);

  const row = (slug: string) => page.locator(`[data-testid="app-row"][data-app-slug="${slug}"]`);
  const liveThumb = row(live.slug).getByTestId('app-thumb');
  await expect(liveThumb).toHaveAttribute('data-thumb', 'frame');
  await expect(liveThumb).toHaveAttribute('aria-hidden', 'true');
  await expect(liveThumb).toHaveAttribute('tabindex', '-1');
  const frame = row(live.slug).getByTestId('app-thumb-frame');
  await expect(frame).toHaveAttribute('src', urlOf(prodHost(live.slug)));
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  await expect(frame).toHaveAttribute('loading', 'lazy');
  await expect(frame).toHaveAttribute('tabindex', '-1');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await frame.evaluate((f) => getComputedStyle(f).pointerEvents)).toBe('none');
  // The frame really renders the app (the CSP lets the dashboard origin frame it).
  await expect(row(live.slug).frameLocator('iframe').locator('h1')).toHaveText('Thumbnail marker');
  // Clicking the tile opens the app page, never the app.
  await liveThumb.click();
  await page.waitForURL(new RegExp(`/workspaces/${ws.slug}/apps/${live.slug}$`));
  await page.goBack();
  await expect(row(locked.slug).getByTestId('app-thumb')).toHaveAttribute('data-reason', 'password');
  await expect(row(locked.slug).getByTestId('app-thumb-frame')).toHaveCount(0);
  await expect(row(empty.slug).getByTestId('app-thumb')).toHaveAttribute('data-reason', 'nothing-compiled');

  // ── every app page: header + tabs + breadcrumb, one width ─────────────────
  const base = `/workspaces/${ws.slug}/apps/${live.slug}`;
  const appCrumbs = [
    { label: 'Workspaces', href: '/workspaces', current: false },
    { label: wsName, href: `/workspaces/${ws.slug}/apps`, current: false },
  ];
  for (const [path, tab, label] of [
    ['', 'overview', null],
    ['/files', 'files', 'Files'],
    ['/data', 'data', 'Data'],
    ['/modules', 'modules', 'Modules'],
    ['/forms', 'forms', 'Forms'],
    ['/end-users', 'end-users', 'Users'],
    ['/uploads', 'uploads', 'Uploads'],
    ['/logs', 'logs', 'Logs'],
    ['/domains', 'domains', 'Domains'],
    ['/settings', 'settings', 'Settings'],
  ] as const) {
    await page.goto(`${base}${path}`);
    await expect(page.getByTestId('app-header'), path).toBeVisible();
    await expect(page.locator(`[data-testid="app-tab"][data-tab="${tab}"]`), path).toHaveAttribute('aria-current', 'page');
    expect(await crumbs(page), path).toEqual(
      label === null
        ? [...appCrumbs, { label: live.slug, href: null, current: true }]
        : [...appCrumbs, { label: live.slug, href: base, current: false }, { label, href: null, current: true }]
    );
    expect(await mainWidth(page), `width of ${path || 'overview'}`).toBe(listWidth);
    // No "← back" links: the breadcrumb replaced them.
    await expect(page.locator('main a', { hasText: '←' }), path).toHaveCount(0);
  }

  // The module detail page keeps the app header + tabs (Modules active).
  await page.goto(`${base}/modules/data`);
  await expect(page.getByTestId('app-header')).toBeVisible();
  await expect(page.locator('[data-testid="app-tab"][data-tab="modules"]')).toHaveAttribute('aria-current', 'page');
  expect(await crumbs(page)).toEqual([
    ...appCrumbs,
    { label: live.slug, href: base, current: false },
    { label: 'Modules', href: `${base}/modules`, current: false },
    { label: 'data', href: null, current: true },
  ]);
  await expect(page.getByTestId('app-locked-by-admin')).toHaveCount(0);

  // ── Activity: selects, Apply, Clear and Export CSV on one line ────────────
  await page.goto(`/workspaces/${ws.slug}/activity`);
  expect((await crumbs(page)).map((c) => c.label)).toEqual(['Workspaces', wsName, 'Activity']);
  await expect(page.locator('[data-testid="workspace-tab"][data-tab="activity"]')).toHaveAttribute('aria-current', 'page');
  await expectAligned([
    page.getByTestId('filter-app'),
    page.getByTestId('filter-action'),
    page.getByTestId('filter-actor'),
    page.getByTestId('filter-apply'),
    page.getByTestId('filter-clear'),
    page.getByTestId('csv-export'),
  ]);
  expect(await height(page.getByTestId('filter-app'))).toBe(await height(page.getByTestId('filter-apply')));
  expect(await mainWidth(page)).toBe(listWidth);

  // ── the other workspace pages share the chrome ─────────────────────────────
  for (const [path, tab, label] of [
    ['', 'members', 'Members'],
    ['/upstreams', 'upstreams', 'Upstreams'],
  ] as const) {
    await page.goto(`/workspaces/${ws.slug}${path}`);
    expect((await crumbs(page)).map((c) => c.label), path).toEqual(['Workspaces', wsName, label]);
    await expect(page.locator(`[data-testid="workspace-tab"][data-tab="${tab}"]`)).toHaveAttribute('aria-current', 'page');
    expect(await mainWidth(page)).toBe(listWidth);
  }
  await expect(page.getByTestId('upstreams-intro')).toContainText('An upstream is an external API');
  await expect(page.getByTestId('upstreams-intro')).toContainText('ever sees it');

  // ── (5) the footer ─────────────────────────────────────────────────────────
  const version = (await (await request.get(`${BASE_URL_WEB}/api/version`)).json()) as { sha: string; version: string };
  await expect(page.getByTestId('footer-version')).toHaveText(`drobek ${version.version}`);
  await expect(page.getByTestId('source-link')).toHaveText('Source (AGPL-3.0)');
  if (/^[0-9a-f]{7,40}$/.test(version.sha)) await expect(page.getByTestId('footer-sha')).toHaveText(version.sha.slice(0, 7));
  const stars = page.getByTestId('footer-stars');
  if ((await stars.count()) > 0) {
    // Only once the server-side count is known (api.github.com may be unreachable).
    await expect(stars).toHaveText(/^★ [\d,]+$/);
    await expect(stars).toHaveAttribute('href', 'https://github.com/freema/drobek');
  }

  // ── (6) phone width: no horizontal scroll, the breadcrumb wraps ────────────
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    `/workspaces/${ws.slug}/apps`,
    base,
    `${base}/data`,
    `${base}/modules`,
    `${base}/modules/data`,
    `/workspaces/${ws.slug}/activity`,
  ]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  await page.waitForLoadState('networkidle');
});
