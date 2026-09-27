import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { prodHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * NSO-340: duplicating a gallery app end to end on the local stack
 * (GALLERY_ENABLED is on in docker-compose.yml and docker-compose.e2e.yaml).
 *
 *  - the owner lists a published app with "Allow duplicates" on its Overview
 *    → the public API item says `duplicable: true` with the dashboard's
 *    `/duplicate/<slug>` as `duplicateUrl`;
 *  - a signed-out visitor of that URL lands on /login and, signed in, back on
 *    the confirm page (source name, what is and is not copied, a workspace
 *    picker, the "<name> copy" default name);
 *  - Duplicate opens the new app: "Duplicated from <slug>" in its header and
 *    a notice of what happened to the module settings, not published; the gallery item counts `duplicates: 1`; audit
 *    `app.duplicate` (copier) and `app.duplicated` (source, no copier);
 *  - MCP: `duplicate_app` copies the same app into the agent's workspace;
 *  - the owner turns duplicates off → the confirm page refuses
 *    (`not_duplicable`), the API item says `duplicable: false`,
 *    `duplicateUrl: null`.
 */

const GALLERY = `${BASE_URL_WEB}/api/public/gallery`;

interface Item {
  url: string;
  duplicable: boolean;
  duplicateUrl: string | null;
  duplicates: number;
}

async function itemOf(request: APIRequestContext, slug: string): Promise<Item | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const res = await request.get(`${GALLERY}?limit=48${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: Item[]; next?: string };
    const hit = body.items.find((i) => i.url === urlOf(prodHost(slug)));
    if (hit) return hit;
    if (!body.next) return undefined;
    cursor = body.next;
  }
  return undefined;
}

test.describe.configure({ mode: 'serial' });

test.describe('gallery: duplicate an app from the dashboard and over MCP (NSO-340) @local', () => {
  let owner: McpClient;
  let app: { app_id: string; slug: string };
  let overview: string;

  test.afterAll(async () => {
    if (owner && app) await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: false }).catch(() => {});
    await owner?.client.close().catch(() => {});
  });

  test('the owner allows duplicates; the public item links the duplicate page', async ({ page, request }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'dup-owner', scope: FULL_SCOPE });
    const created = await callTool(owner.client, 'create_app', { name: 'Duplicable Pixel Wall', workspace: owner.workspace, template: 'html' });
    expect(created.isError, created.text).toBe(false);
    app = created.json as unknown as { app_id: string; slug: string };
    overview = `/workspaces/${owner.workspace}/apps/${app.slug}`;
    expect((await callTool(owner.client, 'publish', { app_id: app.app_id })).isError).toBe(false);

    await page.goto(overview);
    const section = page.getByTestId('gallery-section');
    await section.getByTestId('gallery-description').fill('Paint pixels together.');
    await section.getByTestId('gallery-listed').check();
    await section.getByTestId('gallery-allow-duplicate').check();
    await section.getByTestId('gallery-save').click();
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'visible');

    const item = await itemOf(request, app.slug);
    expect(item).toMatchObject({ duplicable: true, duplicateUrl: `${BASE_URL_WEB}/duplicate/${app.slug}`, duplicates: 0 });
  });

  test('a signed-out visitor signs in, comes back and duplicates the app', async ({ browser, request }) => {
    skipUnlessLocal();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL_WEB}/duplicate/${app.slug}`);
      await expect(page).toHaveURL(/\/login\?returnTo=/);
      await loginViaEmail(page, request, uniqueEmail('dup-copier'));
      await page.goto(`${BASE_URL_WEB}/duplicate/${app.slug}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Duplicable Pixel Wall');
      await expect(page.getByTestId('duplicate-what')).toContainText('Secrets and API keys');
      await expect(page.getByTestId('duplicate-name')).toHaveValue('Duplicable Pixel Wall copy');
      await page.getByTestId('duplicate-name').fill('My pixel wall');
      await page.getByTestId('duplicate-submit').click();

      await expect(page).toHaveURL(/\/workspaces\/[^/]+\/apps\/my-pixel-wall[a-z0-9-]*\?duplicated=/);
      await expect(page.getByTestId('app-duplicated-from')).toContainText(`Duplicated from ${app.slug}`);
      await expect(page.getByTestId('duplicate-result')).toContainText(`Copied from ${app.slug}.`);
      const copySlug = new URL(page.url()).pathname.split('/apps/')[1];

      expect(await itemOf(request, app.slug)).toMatchObject({ duplicates: 1 });
      const audit = await withDb(async (c) =>
        (
          await c.query(
            `SELECT action, target, actor_user_id FROM audit_log WHERE action IN ('app.duplicate', 'app.duplicated') AND target IN ($1, $2) ORDER BY created_at`,
            [app.slug, copySlug]
          )
        ).rows as { action: string; target: string; actor_user_id: string | null }[]
      );
      expect(audit.find((a) => a.action === 'app.duplicate')).toMatchObject({ target: copySlug });
      expect(audit.find((a) => a.action === 'app.duplicated')).toMatchObject({ target: app.slug, actor_user_id: null });
    } finally {
      await context.close();
    }
  });

  test('MCP: duplicate_app copies the app into the agent\'s workspace', async () => {
    skipUnlessLocal();
    const r = await callTool(owner.client, 'duplicate_app', { from: app.slug, name: 'Agent pixel wall' });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ version: 1, from: app.slug, workspace: owner.workspace });
    const got = await callTool(owner.client, 'get_app', { app_id: String(r.json.app_id) });
    expect(got.json).toMatchObject({ duplicated_from: app.slug });
  });

  test('the owner turns duplicates off → the page refuses and the item is no longer duplicable', async ({ page, request }) => {
    skipUnlessLocal();
    const off = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description: 'Paint pixels together.',
      allow_duplicate: false,
      user_confirmed: true,
    });
    expect(off.json).toMatchObject({ allow_duplicate: false });
    expect(await itemOf(request, app.slug)).toMatchObject({ duplicable: false, duplicateUrl: null });
    await page.goto(`${BASE_URL_WEB}/duplicate/${app.slug}`);
    await expect(page.getByTestId('duplicate-refused')).toHaveAttribute('data-reason', 'not_duplicable');
  });
});
