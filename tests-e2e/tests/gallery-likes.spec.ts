import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { prodHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, ownClientIpHeaders, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * NSO-340: likes and opens of a gallery entry on the local stack.
 *
 *  - `openUrl` redirects to the production host and counts a GET once;
 *    a prefetch and a HEAD redirect without counting;
 *  - `likeUrl` sends a signed-out visitor to /login with the way back; a
 *    signed-in account likes once, unlikes, and returns to `back` only on a
 *    GALLERY_FRAME_ANCESTORS origin;
 *  - the public API shows `likes` / `opens` and `sort=popular` answers in
 *    page mode.
 */

const GALLERY_ORIGIN = 'https://gallery.example.test';
const GALLERY = `${BASE_URL_WEB}/api/public/gallery`;

interface Created {
  app_id: string;
  slug: string;
}

async function opensOf(appId: string): Promise<number> {
  return withDb(async (c) =>
    Number((await c.query(`SELECT COALESCE(SUM(count), 0) AS n FROM gallery_opens WHERE app_id = $1`, [appId])).rows[0].n)
  );
}

async function likesOf(appId: string): Promise<number> {
  return withDb(async (c) => Number((await c.query(`SELECT COUNT(*) AS n FROM gallery_likes WHERE app_id = $1`, [appId])).rows[0].n));
}

test.describe.configure({ mode: 'serial' });

test.describe('gallery likes and opens (NSO-340) @local', () => {
  let owner: McpClient;
  let app: Created;
  const name = `Likes Board ${Date.now().toString(36)}`;

  test.afterAll(async () => {
    if (owner && app) await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: false }).catch(() => {});
    await owner?.client.close().catch(() => {});
  });

  test('openUrl counts a visit and redirects; prefetch and HEAD are not counted', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'gallery-likes-owner', scope: FULL_SCOPE });
    const created = await callTool(owner.client, 'create_app', { name, workspace: owner.workspace });
    expect(created.isError, created.text).toBe(false);
    app = created.json as unknown as Created;
    expect((await callTool(owner.client, 'publish', { app_id: app.app_id })).isError).toBe(false);
    const listed = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description: 'A board people can like.',
      user_confirmed: true,
    });
    expect(listed.isError, listed.text).toBe(false);

    const openUrl = `${BASE_URL_WEB}/gallery/open/${app.slug}`;
    const headers = ownClientIpHeaders();
    const prefetch = await request.get(openUrl, { maxRedirects: 0, headers: { ...headers, 'Sec-Purpose': 'prefetch' } });
    expect(prefetch.status()).toBe(302);
    const head = await request.head(openUrl, { maxRedirects: 0, headers });
    expect(head.status()).toBe(302);
    expect(await opensOf(app.app_id)).toBe(0);

    const open = await request.get(openUrl, { maxRedirects: 0, headers });
    expect(open.status()).toBe(302);
    expect(open.headers()['location']).toBe(urlOf(prodHost(app.slug)));
    expect(open.headers()['cache-control']).toBe('no-store');
    expect(open.headers()['referrer-policy']).toBe('no-referrer');
    expect(await opensOf(app.app_id)).toBe(1);

    const missing = await request.get(`${BASE_URL_WEB}/gallery/open/no-such-gallery-app`, { maxRedirects: 0 });
    expect(missing.status()).toBe(404);
  });

  test('likeUrl: sign in first, like once, unlike, back only to the gallery origin', async ({ browser, request }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const likePath = `/gallery/like/${app.slug}`;
      await page.goto(`${likePath}?back=${encodeURIComponent(`${GALLERY_ORIGIN}/`)}`);
      await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${encodeURIComponent(likePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

      await loginViaEmail(page, request, uniqueEmail('gallery-liker'), new RegExp(`${likePath}\\?back=`));
      await page.goto(likePath);
      await expect(page.getByTestId('gallery-like-count')).toContainText('0');
      await page.getByTestId('gallery-like').click();
      await expect(page.getByTestId('gallery-unlike')).toBeVisible();
      await expect(page.getByTestId('gallery-like-count')).toContainText('1');
      expect(await likesOf(app.app_id)).toBe(1);

      const popular = await request.get(`${GALLERY}?sort=popular&q=${encodeURIComponent(name)}`);
      expect(popular.status()).toBe(200);
      expect(await popular.json()).toMatchObject({
        page: 1,
        total: 1,
        items: [{ name, likes: 1, opens: 1, openUrl: `${BASE_URL_WEB}/gallery/open/${app.slug}`, likeUrl: `${BASE_URL_WEB}${likePath}` }],
      });

      await page.getByTestId('gallery-unlike').click();
      await expect(page.getByTestId('gallery-like')).toBeVisible();
      expect(await likesOf(app.app_id)).toBe(0);

      await page.route(`${GALLERY_ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'gallery' }));
      await page.goto(`${likePath}?back=${encodeURIComponent(`${GALLERY_ORIGIN}/apps`)}`);
      await page.getByTestId('gallery-like').click();
      await page.waitForURL(`${GALLERY_ORIGIN}/apps`);
      expect(await likesOf(app.app_id)).toBe(1);

      await page.goto(`${likePath}?back=${encodeURIComponent('https://elsewhere.example.test/')}`);
      await page.getByTestId('gallery-unlike').click();
      await expect(page.getByTestId('gallery-like')).toBeVisible();
      expect(page.url()).toContain(likePath);
      expect(await likesOf(app.app_id)).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
