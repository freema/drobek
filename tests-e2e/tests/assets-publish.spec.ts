import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, prodHost } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * NSO-362: assets honour publish. An upload, a replacement or a delete
 * changes the app's DRAFT assets — the preview host shows it at once, the
 * production host only after `publish`:
 *
 *  - publish v2 with logo A → production serves A;
 *  - replace the logo with B and add extra.jpg → the preview serves B and
 *    extra.jpg, production still A and 404; list_assets says `published:
 *    false`, `changes_pending_publish: true`;
 *  - delete extra.jpg after it went live → gone from the preview, production
 *    keeps it until the next publish (`published_only`);
 *  - publish v3 → production serves B; publish `version: 2` (the rollback)
 *    → production serves A again (`assets: "as_last_published"`);
 *  - restore_version 2 → the draft assets go back to A (`assets_restored`),
 *    the preview serves A; publishing the restore keeps A live;
 *  - a Range header without `=` is ignored → 200 (RFC 9110).
 */

interface Created {
  app_id: string;
  slug: string;
}

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
/** JPEG magic bytes + random filler: sniffed as image/jpeg, distinct per call. */
const fakeJpeg = (size: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 4)]);
const onDashboard = (url: string): string => `${BASE_URL_WEB}${new URL(url).pathname}`;

test.describe.configure({ mode: 'serial' });

test.describe('assets honour publish (NSO-362) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let app: Created & { preview: string; prod: string };
  const logoA = fakeJpeg(3000);
  const logoB = fakeJpeg(3500);
  const extra = fakeJpeg(1500);

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  async function upload(path: string, body: Buffer): Promise<void> {
    const grant = await callTool(mcp.client, 'create_asset_upload', { app_id: app.app_id, path, size: body.length });
    expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
    const r = await owner.request.put(onDashboard(String(grant.json.upload_url)), {
      data: body,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(r.status(), await r.text()).toBe(201);
  }

  async function bytesAt(host: string, path: string): Promise<{ status: number; bytes: Buffer }> {
    const r = await hostRequest(host, path);
    return { status: r.status, bytes: r.bytes };
  }

  async function write(content: string): Promise<void> {
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'index.html', content }],
      reasoning: 'A page with a logo',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
  }

  test('uploads and deletes reach production only with publish', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'assets-publish', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    const created = (await callTool(mcp.client, 'create_app', { name: `Asset publish ${STAMP}`, template: 'html' })).json as unknown as Created;
    app = { ...created, preview: previewHost(created.slug), prod: prodHost(created.slug) };

    await write('<!doctype html><h1>v2</h1><img src="logo.jpg" alt="logo">');
    await upload('logo.jpg', logoA);
    const p1 = await callTool(mcp.client, 'publish', { app_id: app.app_id });
    expect(p1.isError, JSON.stringify(p1.json)).toBe(false);
    expect(p1.json).toMatchObject({ published_version: 2, assets: 'draft' });
    expect((await bytesAt(app.prod, '/logo.jpg')).bytes.equals(logoA)).toBe(true);

    // Replace + add: preview at once, production unchanged.
    await upload('logo.jpg', logoB);
    await upload('extra.jpg', extra);
    expect((await bytesAt(app.preview, '/logo.jpg')).bytes.equals(logoB)).toBe(true);
    expect((await bytesAt(app.preview, '/extra.jpg')).status).toBe(200);
    expect((await bytesAt(app.prod, '/logo.jpg')).bytes.equals(logoA)).toBe(true);
    expect((await bytesAt(app.prod, '/extra.jpg')).status).toBe(404);
    const listed = await callTool(mcp.client, 'list_assets', { app_id: app.app_id });
    expect(listed.json).toMatchObject({ changes_pending_publish: true, published_only: [] });
    expect((listed.json.assets as { path: string; published: boolean }[]).map((a) => [a.path, a.published])).toEqual([
      ['/extra.jpg', false],
      ['/logo.jpg', false],
    ]);

    // A new version + publish → B and extra.jpg live.
    await write('<!doctype html><h1>v3</h1><img src="logo.jpg" alt="logo"><img src="extra.jpg" alt="">');
    const p2 = await callTool(mcp.client, 'publish', { app_id: app.app_id });
    expect(p2.json).toMatchObject({ published_version: 3, assets: 'draft' });
    expect((await bytesAt(app.prod, '/logo.jpg')).bytes.equals(logoB)).toBe(true);
    expect((await bytesAt(app.prod, '/extra.jpg')).status).toBe(200);

    // Delete after it went live: the preview drops it, production keeps it.
    const del = await callTool(mcp.client, 'delete_asset', { app_id: app.app_id, path: 'extra.jpg' });
    expect(del.isError, JSON.stringify(del.json)).toBe(false);
    expect((await bytesAt(app.preview, '/extra.jpg')).status).toBe(404);
    expect((await bytesAt(app.prod, '/extra.jpg')).status).toBe(200);
    expect((await callTool(mcp.client, 'list_assets', { app_id: app.app_id })).json).toMatchObject({
      published_only: ['/extra.jpg'],
      changes_pending_publish: true,
    });
  });

  test('the rollback (publish an older version) brings back the assets it served', async () => {
    skipUnlessLocal();
    const back = await callTool(mcp.client, 'publish', { app_id: app.app_id, version: 2 });
    expect(back.json).toMatchObject({ published_version: 2, previous_version: 3, assets: 'as_last_published' });
    expect((await bytesAt(app.prod, '/logo.jpg')).bytes.equals(logoA)).toBe(true);
    expect((await bytesAt(app.prod, '/extra.jpg')).status).toBe(404);
    // The preview (the draft) is untouched by the rollback.
    expect((await bytesAt(app.preview, '/logo.jpg')).bytes.equals(logoB)).toBe(true);
  });

  test('restore_version of a published version resets the draft assets; publishing it keeps them live', async () => {
    skipUnlessLocal();
    const r = await callTool(mcp.client, 'restore_version', { app_id: app.app_id, version: 2 });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json).toMatchObject({ version: 4, restored_from: 2, assets_restored: true });
    expect((await bytesAt(app.preview, '/logo.jpg')).bytes.equals(logoA)).toBe(true);
    const p = await callTool(mcp.client, 'publish', { app_id: app.app_id });
    expect(p.json).toMatchObject({ published_version: 4, assets: 'draft' });
    expect((await bytesAt(app.prod, '/logo.jpg')).bytes.equals(logoA)).toBe(true);
    expect((await callTool(mcp.client, 'list_assets', { app_id: app.app_id })).json).toMatchObject({ changes_pending_publish: false });
  });

  test('a Range header without "=" is ignored: the whole file (200), not 416', async () => {
    skipUnlessLocal();
    const r = await hostRequest(app.prod, '/logo.jpg', { headers: { Range: 'bytes' } });
    expect(r.status).toBe(200);
    expect(r.bytes.equals(logoA)).toBe(true);
  });
});
