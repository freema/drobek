import { expect, test } from '@playwright/test';
import { hostRequest, previewHost, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * App traffic analytics end to end on the local stack: a published app's
 * production page is opened a few times with different user agents (one of
 * them a bot, one a drobek check, one from an external site) plus requests
 * that must not count (the preview host, a prefetch, a HEAD, the app list's
 * thumbnail); the live counters
 * show at once — on the Analytics tab, the Overview's visits panel, get_app's
 * `traffic` and get_analytics (inside the untrusted envelope) — without
 * waiting for the hourly rollup.
 */

interface Created {
  app_id: string;
  slug: string;
}

interface Analytics {
  days: number;
  enabled: boolean;
  untrusted: true;
  series: { day: string; views: number; visitors: number; bot_views: number }[];
  totals: { views: number; visitors: number; bot_views: number; bot_share: number | null };
  top_paths: { path: string; views: number }[];
  top_referrers: { host: string; views: number }[];
}

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const FIREFOX = `Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0 e2e-${STAMP}`;
const SAFARI = `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 e2e-${STAMP}`;
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

test.describe.configure({ mode: 'serial' });

test.describe('app traffic analytics @local', () => {
  let mcp: McpClient;
  let app: Created;

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('page views, visitors, bots, top pages and referrers on the tab and over MCP', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'analytics', scope: FULL_SCOPE });
    app = (await callTool(mcp.client, 'create_app', { name: `Visits ${STAMP}`, template: 'html' })).json as unknown as Created;
    const base = `/workspaces/${mcp.workspace}/apps/${app.slug}`;

    // Not published yet: the tab says how to get visits.
    await page.goto(`${base}/analytics`);
    await expect(page.getByTestId('analytics-empty')).toContainText('No visits yet — publish the app and share its address');
    await expect(page.getByTestId('analytics-privacy')).toContainText('without cookies');

    const published = await callTool(mcp.client, 'publish', { app_id: app.app_id });
    expect(published.isError, published.text).toBe(false);
    const prod = prodHost(app.slug);

    // Counted: two people (one twice, one from an external site with a query on the page), one bot.
    for (const [path, headers] of [
      ['/', { 'User-Agent': FIREFOX, 'Sec-Fetch-Dest': 'document' }],
      ['/', { 'User-Agent': FIREFOX, 'Sec-Fetch-Dest': 'document' }],
      ['/pricing?ref=newsletter', { 'User-Agent': SAFARI, Referer: 'https://news.example/item?id=42' }],
      ['/', { 'User-Agent': BOT }],
    ] as const) {
      const r = await hostRequest(prod, path, { headers });
      expect(r.status, `${path} ${headers['User-Agent']}`).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/html');
    }
    // Not counted: drobek's own check, the preview host, a prefetch, a HEAD.
    expect((await hostRequest(prod, '/', { headers: { 'User-Agent': 'drobek-smoke' } })).status).toBe(200);
    expect((await hostRequest(previewHost(app.slug), '/', { headers: { 'User-Agent': FIREFOX } })).status).toBe(200);
    expect((await hostRequest(prod, '/', { headers: { 'User-Agent': FIREFOX, 'Sec-Purpose': 'prefetch' } })).status).toBe(200);
    expect((await hostRequest(prod, '/', { method: 'HEAD', headers: { 'User-Agent': FIREFOX } })).status).toBe(200);
    // Not counted either: the app list's live thumbnail of the production address.
    await page.goto(`/workspaces/${mcp.workspace}/apps`);
    const thumb = page.locator(`[data-testid="app-row"][data-app-slug="${app.slug}"]`).getByTestId('app-thumb-frame');
    await thumb.scrollIntoViewIfNeeded();
    await expect(thumb.contentFrame().locator('body')).toBeAttached();

    // MCP: live counts, without waiting for the rollup (counting is fire-and-forget: poll briefly).
    let a: Analytics | null = null;
    let text = '';
    await expect
      .poll(
        async () => {
          const r = await callTool(mcp.client, 'get_analytics', { app_id: app.app_id, days: 7 });
          expect(r.isError, r.text).toBe(false);
          a = r.json as unknown as Analytics;
          text = r.text;
          return [a.totals.views, a.totals.bot_views];
        },
        { timeout: 5_000, intervals: [250] }
      )
      .toEqual([3, 1]);
    const got = a as unknown as Analytics;
    expect(got.days).toBe(7);
    expect(got.series).toHaveLength(7);
    expect(got.series.at(-1)).toMatchObject({ views: 3, visitors: 2, bot_views: 1 });
    expect(got.totals.bot_share).toBe(0.25);
    expect(got.top_paths).toEqual([
      { path: '/', views: 2 },
      { path: '/pricing', views: 1 },
    ]);
    expect(got.top_referrers).toEqual([{ host: 'news.example', views: 1 }]);
    expect(text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
    const nonce = /<untrusted-app-analytics [^>]*nonce="([0-9a-f]{16})">/.exec(text)?.[1];
    expect(nonce).toBeTruthy();
    expect(text).toContain(`</untrusted-app-analytics nonce="${nonce}">`);
    expect(text).not.toContain('newsletter');
    expect(text).not.toContain('id=42');

    const info = await callTool(mcp.client, 'get_app', { app_id: app.app_id });
    expect(info.json.traffic).toEqual({ days: 7, views: 3, visitors: 2, bot_views: 1 });

    // The dashboard tab and the Overview panel show the same numbers.
    await page.goto(`${base}/analytics?days=7`);
    await expect(page.getByTestId('analytics-views')).toHaveText('3');
    await expect(page.getByTestId('analytics-visitors')).toHaveText('2');
    await expect(page.getByTestId('analytics-bot-share')).toHaveText('25 %');
    await expect(page.getByTestId('analytics-chart')).toBeVisible();
    await expect(page.getByTestId('analytics-paths-row')).toHaveCount(2);
    await expect(page.getByTestId('analytics-paths-row').first()).toContainText('/');
    await expect(page.getByTestId('analytics-referrers-row')).toHaveText([/news\.example\s*1/]);
    await page.getByTestId('analytics-days').selectOption('30');
    await page.getByTestId('analytics-refresh').click();
    await expect(page).toHaveURL(/\?days=30$/);
    await expect(page.getByTestId('analytics-views')).toHaveText('3');

    await page.goto(base);
    await expect(page.getByTestId('visits-views')).toHaveText('3');
    await expect(page.getByTestId('visits-visitors')).toHaveText('2');
    await page.getByTestId('visits-link').click();
    await expect(page).toHaveURL(new RegExp(`${base}/analytics$`));
    await page.waitForLoadState('networkidle');
  });
});
