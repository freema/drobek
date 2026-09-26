import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { prodHost, urlOf } from './helpers/apps-host';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { addMembership, personalWorkspaceOf, userIdByEmail, withDb } from './helpers/seed';

/**
 * NSO-340: the public gallery end to end on the local stack (GALLERY_ENABLED
 * is on in docker-compose.yml and docker-compose.e2e.yaml).
 *
 *  - dashboard: the owner lists a published app on its Overview → it is in
 *    GET /api/public/gallery with name / description / production URL /
 *    publishedAt and NOTHING about the owner; CORS * + `public, max-age=60`;
 *    unticking removes it; audit `app.gallery_listed` / `_unlisted` as the user;
 *  - a viewer's POST (intent=gallery) → 403, nothing changes;
 *  - unpublishing a listed app removes it (and clears the flag, audited with
 *    reason `unpublish`);
 *  - MCP: `set_gallery_listing` without `user_confirmed: true` →
 *    user_confirmation_required and nothing listed; with it → in the API,
 *    get_app shows the state, audited as the agent; unlisting → gone;
 *  - a super-admin hides the entry in /admin/abuse → gone at once; the agent
 *    cannot re-list it (gallery_hidden) and the Overview says so; "Show again"
 *    brings it back.
 *
 * The super-admin is `e2e-superadmin@drobek.test` (see abuse.spec.ts).
 */

const SUPER_ADMIN = 'e2e-superadmin@drobek.test';
const GALLERY = `${BASE_URL_WEB}/api/public/gallery`;

interface GalleryItem {
  name: string;
  description: string;
  url: string;
  publishedAt: string;
}

interface Created {
  app_id: string;
  slug: string;
}

/** Every page of the public gallery (other specs may list apps too). */
async function galleryItems(request: APIRequestContext): Promise<GalleryItem[]> {
  const items: GalleryItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const res = await request.get(`${GALLERY}?limit=48${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status(), 'GET /api/public/gallery').toBe(200);
    const body = (await res.json()) as { items: GalleryItem[]; next?: string };
    items.push(...body.items);
    if (!body.next) return items;
    cursor = body.next;
  }
  throw new Error('the gallery has more than 50 pages');
}

async function entryOf(request: APIRequestContext, slug: string): Promise<GalleryItem | undefined> {
  return (await galleryItems(request)).find((i) => i.url === urlOf(prodHost(slug)));
}

async function galleryAudit(
  slug: string
): Promise<{ action: string; actor_kind: string; actor_user_id: string | null; meta: Record<string, unknown> | null }[]> {
  return withDb(async (c) =>
    (
      await c.query(
        `SELECT action, actor_kind, actor_user_id, meta FROM audit_log
          WHERE subject_type = 'app' AND target = $1 AND action LIKE 'app.gallery_%'
          ORDER BY created_at`,
        [slug]
      )
    ).rows
  );
}

async function listedFlag(appId: string): Promise<{ gallery_listed: boolean; gallery_description: string | null }> {
  return withDb(async (c) =>
    (await c.query(`SELECT gallery_listed, gallery_description FROM apps WHERE id = $1`, [appId])).rows[0]
  );
}

async function publish(mcp: McpClient, appId: string): Promise<void> {
  const p = await callTool(mcp.client, 'publish', { app_id: appId });
  expect(p.isError, p.text).toBe(false);
}

async function saveGallery(page: Page, opts: { listed: boolean; description?: string }): Promise<void> {
  const section = page.getByTestId('gallery-section');
  if (opts.description !== undefined) await section.getByTestId('gallery-description').fill(opts.description);
  const box = section.getByTestId('gallery-listed');
  if (opts.listed) await box.check();
  else await box.uncheck();
  await section.getByTestId('gallery-save').click();
}

test.describe.configure({ mode: 'serial' });

test.describe('gallery: list from the dashboard and over MCP, public API, admin hide (NSO-340) @local', () => {
  let owner: McpClient;
  let app: Created;
  let overview: string;
  let admin: BrowserContext | null = null;
  const description = 'Plan weekly shifts for a small team — no sign-up.';

  test.afterAll(async () => {
    // Leave nothing listed behind in the shared dev database.
    if (owner && app) await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: false }).catch(() => {});
    await owner?.client.close().catch(() => {});
    await admin?.close().catch(() => {});
  });

  test('dashboard: the owner lists a published app → public API (no owner data); unticking removes it', async ({
    page,
    request,
  }) => {
    skipUnlessLocal();
    owner = await mcpClient(page, request, { tag: 'gallery-owner', scope: FULL_SCOPE });
    const created = await callTool(owner.client, 'create_app', { name: 'Gallery Shift Planner', workspace: owner.workspace });
    expect(created.isError, created.text).toBe(false);
    app = created.json as unknown as Created;
    overview = `/workspaces/${owner.workspace}/apps/${app.slug}`;

    // Before publishing: the Overview says "publish first" and the switch is off.
    await page.goto(overview);
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'unlisted');
    await expect(page.getByTestId('gallery-needs-publish')).toBeVisible();
    await expect(page.getByTestId('gallery-listed')).toBeDisabled();

    await publish(owner, app.app_id);
    await page.goto(overview);
    await expect(page.getByTestId('gallery-needs-publish')).toHaveCount(0);
    await saveGallery(page, { listed: true, description: `  ${description}  ` });
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'visible');
    expect(await listedFlag(app.app_id)).toEqual({ gallery_listed: true, gallery_description: description });

    // The public API: CORS *, a 60 s public cache, the four fields only.
    const res = await request.get(GALLERY);
    expect(res.status()).toBe(200);
    expect(res.headers()['access-control-allow-origin']).toBe('*');
    expect(res.headers()['cache-control']).toBe('public, max-age=60');
    expect(res.headers()['content-type']).toContain('application/json');
    const entry = await entryOf(request, app.slug);
    expect(entry, 'the listed app is in the gallery').toBeTruthy();
    expect(entry).toEqual({
      name: 'Gallery Shift Planner',
      description,
      url: urlOf(prodHost(app.slug)),
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    const all = await galleryItems(request);
    for (const item of all) expect(Object.keys(item).sort()).toEqual(['description', 'name', 'publishedAt', 'url']);
    const text = JSON.stringify(all);
    const ws = await personalWorkspaceOf(owner.email);
    for (const secret of [owner.email, ws.id, app.app_id, await userIdByEmail(owner.email)]) expect(text).not.toContain(secret);

    // Read-only: anything but GET/HEAD → 405.
    expect((await request.post(GALLERY, { headers: { Origin: BASE_URL_WEB } })).status()).toBe(405);

    // Unticking removes it at once.
    await saveGallery(page, { listed: false });
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'unlisted');
    expect(await entryOf(request, app.slug)).toBeUndefined();

    const userId = await userIdByEmail(owner.email);
    const audit = await galleryAudit(app.slug);
    expect(audit.map((a) => a.action)).toEqual(['app.gallery_listed', 'app.gallery_unlisted']);
    expect(audit.every((a) => a.actor_kind === 'user' && a.actor_user_id === userId)).toBe(true);
    expect(audit[1].meta).toMatchObject({ reason: 'owner' });
  });

  test('a viewer cannot list the app (403, nothing changes)', async ({ browser, request }) => {
    skipUnlessLocal();
    const viewerEmail = uniqueEmail('gallery-viewer');
    const ctx = await browser.newContext();
    try {
      const vp = await ctx.newPage();
      await loginViaEmail(vp, request, viewerEmail);
      const ws = await personalWorkspaceOf(owner.email);
      await addMembership(await userIdByEmail(viewerEmail), ws.id, 'viewer');

      // The viewer sees the state but no form.
      await vp.goto(overview);
      await expect(vp.getByTestId('gallery-section')).toBeVisible();
      await expect(vp.getByTestId('gallery-form')).toHaveCount(0);

      const res = await vp.request.post(`${BASE_URL_WEB}${overview}`, {
        headers: { Origin: BASE_URL_WEB },
        form: { intent: 'gallery', listed: 'on', description: 'Listed by a viewer.' },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(403);
      expect(await listedFlag(app.app_id)).toMatchObject({ gallery_listed: false });
      expect(await entryOf(request, app.slug)).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  test('unpublishing a listed app takes it out of the gallery and clears the flag', async ({ page, request }) => {
    skipUnlessLocal();
    await loginViaEmail(page, request, owner.email);
    await page.goto(overview);
    await saveGallery(page, { listed: true, description });
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'visible');
    expect(await entryOf(request, app.slug)).toBeTruthy();

    await page.getByTestId('unpublish-button').click();
    await expect(page.getByTestId('app-published-version')).toContainText('not published');
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'unlisted');
    expect(await entryOf(request, app.slug)).toBeUndefined();
    expect(await listedFlag(app.app_id)).toMatchObject({ gallery_listed: false });
    const last = (await galleryAudit(app.slug)).at(-1);
    expect(last).toMatchObject({ action: 'app.gallery_unlisted', meta: { reason: 'unpublish' } });
  });

  test('MCP: set_gallery_listing needs user_confirmed; lists → public API → unlists → gone', async ({ request }) => {
    skipUnlessLocal();
    // Not published → refused before the user is even asked.
    const unpublished = await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: true, description });
    expect(unpublished.isError).toBe(true);
    expect(unpublished.json.code).toBe('not_published');

    await publish(owner, app.app_id);
    const before = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect(before.json.gallery).toMatchObject({ enabled: true, listed: false, visible: false, hidden_by_admin: false });

    // Without the user's explicit yes nothing is listed.
    const ask = await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: true, description });
    expect(ask.isError).toBe(true);
    expect(ask.json).toMatchObject({ code: 'user_confirmation_required' });
    expect(String(ask.json.message)).toContain('Ask the user');
    expect(await entryOf(request, app.slug)).toBeUndefined();

    const ok = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description,
      user_confirmed: true,
    });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.json).toMatchObject({ app_id: app.app_id, listed: true, description, changed: true, visible: true });
    expect(await entryOf(request, app.slug)).toMatchObject({ description, url: urlOf(prodHost(app.slug)) });
    const after = await callTool(owner.client, 'get_app', { app_id: app.app_id });
    expect(after.json.gallery).toEqual({ enabled: true, listed: true, description, hidden_by_admin: false, visible: true });
    expect((await galleryAudit(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_listed', actor_kind: 'agent' });

    const off = await callTool(owner.client, 'set_gallery_listing', { app_id: app.app_id, listed: false });
    expect(off.isError, off.text).toBe(false);
    expect(off.json).toMatchObject({ listed: false, changed: true });
    expect(await entryOf(request, app.slug)).toBeUndefined();
    expect((await galleryAudit(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_unlisted', actor_kind: 'agent' });
  });

  test('a super-admin hides the entry: gone at once, the owner cannot re-list it; "Show again" restores it', async ({
    page,
    browser,
    request,
  }) => {
    skipUnlessLocal();
    const listed = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description,
      user_confirmed: true,
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(await entryOf(request, app.slug)).toBeTruthy();

    admin = await browser.newContext();
    const ap = await admin.newPage();
    await loginViaEmail(ap, request, SUPER_ADMIN);
    await ap.goto('/admin/abuse');
    const row = ap.locator(`[data-testid="gallery-entry"][data-app-slug="${app.slug}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId('gallery-hide').click();
    await expect(row.getByTestId('gallery-entry-hidden')).toBeVisible();
    expect(await entryOf(request, app.slug)).toBeUndefined();
    expect((await galleryAudit(app.slug)).at(-1)).toMatchObject({ action: 'app.gallery_hidden', actor_kind: 'user' });

    // The agent is refused; the owner's Overview says why.
    const relist = await callTool(owner.client, 'set_gallery_listing', {
      app_id: app.app_id,
      listed: true,
      description,
      user_confirmed: true,
    });
    expect(relist.isError).toBe(true);
    expect(relist.json.code).toBe('gallery_hidden');
    expect((await callTool(owner.client, 'get_app', { app_id: app.app_id })).json.gallery).toMatchObject({
      hidden_by_admin: true,
      visible: false,
    });
    await loginViaEmail(page, request, owner.email);
    await page.goto(overview);
    await expect(page.getByTestId('gallery-status')).toHaveAttribute('data-state', 'hidden');
    await expect(page.getByTestId('gallery-hidden-notice')).toBeVisible();

    // "Show again" → back in the gallery (the owner's listing was kept).
    await row.getByTestId('gallery-show').click();
    await expect(row.getByTestId('gallery-entry-hidden')).toHaveCount(0);
    expect(await entryOf(request, app.slug)).toBeTruthy();
  });
});
