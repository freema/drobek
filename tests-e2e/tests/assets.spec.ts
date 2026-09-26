import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * NSO-358: app assets — video, audio, images and fonts an app serves at
 * `/<path>` next to its own files, uploaded through a single-use upload URL
 * that never passes through the model. The page is shaped like a ported
 * Claude artifact: `index.html` with `<video src="film.mp4" poster="poster.jpg">`,
 * a relative `s1.jpg`, a Google Fonts stylesheet and a youtube-nocookie embed.
 *
 *  - create_asset_upload → PUT the bytes to `upload_url` (as `curl -T` does)
 *    → 201; the URL is single use (the second PUT is `upload_token_invalid`);
 *  - the preview host serves `/film.mp4` with Range → 206 + Content-Range,
 *    and `/s1.jpg` as image/jpeg; a browser fetching the page loads both
 *    with no CSP violation for the video, the poster, the image, the Google
 *    Fonts stylesheet or the youtube-nocookie iframe — an iframe from any
 *    other origin is refused by `frame-src`;
 *  - the page's CSP carries `media-src` and the curated `frame-src`;
 *  - refusals are `{ code, message, hint }`: over APP_ASSET_MAX_BYTES,
 *    a content type that does not fit the extension, HTML bytes behind a
 *    `.mp4` URL (sniffed → 415), a path the app's own file holds;
 *  - the dashboard's Assets tab lists the assets and deletes one (the preview
 *    host then answers 404), and uploads a file with the same upload URL.
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

interface UploadUrl {
  upload_url: string;
  method: string;
  expires_at: string;
  max_bytes: number;
  asset_path: string;
  asset_url: string;
  curl: string;
}

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const MiB = 1024 * 1024;

/** `size` bytes that sniff as MP4: an `ftyp` box with the isom brand, then random filler. */
function fakeMp4(size: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom\0\0\x02\0isomiso2avc1mp41', 'latin1')]);
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

/** JPEG magic bytes + filler: sniffed as image/jpeg. */
const fakeJpeg = (size: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 4)]);

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Family film</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" />
  </head>
  <body>
    <h1>Family film</h1>
    <video id="film" src="film.mp4" poster="poster.jpg" controls preload="metadata"></video>
    <img id="s1" src="s1.jpg" alt="Scene 1" />
    <iframe id="yt" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="YouTube"></iframe>
    <iframe id="other" src="https://example.com/" title="Not allowed"></iframe>
  </body>
</html>
`;

/** The upload URL on THIS target's dashboard origin (the tool builds it from PUBLIC_APP_URL). */
const onDashboard = (url: string): string => {
  const u = new URL(url);
  return `${BASE_URL_WEB}${u.pathname}`;
};

test.describe.configure({ mode: 'serial' });

test.describe('app assets — video, images, upload URLs (NSO-358) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let app: Created & { host: string };
  const film = fakeMp4(64 * 1024);
  const poster = fakeJpeg(2048);
  const scene = fakeJpeg(4096);

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  async function uploadUrl(path: string, size: number, contentType?: string) {
    return callTool(mcp.client, 'create_asset_upload', {
      app_id: app.app_id,
      path,
      size,
      ...(contentType ? { content_type: contentType } : {}),
    });
  }

  async function put(url: string, body: Buffer) {
    const r = await owner.request.put(onDashboard(url), { data: body, headers: { 'Content-Type': 'application/octet-stream' } });
    return { status: r.status(), json: (await r.json()) as Record<string, unknown> };
  }

  async function upload(path: string, body: Buffer): Promise<void> {
    const grant = await uploadUrl(path, body.length);
    expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
    const put1 = await put((grant.json as unknown as UploadUrl).upload_url, body);
    expect(put1.status, JSON.stringify(put1.json)).toBe(201);
  }

  test('an artifact-shaped page: write_files + create_asset_upload at the relative paths → served with Range', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'assets', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    const created = (await callTool(mcp.client, 'create_app', { name: `Assets ${STAMP}`, template: 'html' })).json as unknown as Created;
    app = { ...created, host: previewHost(created.slug) };

    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'index.html', content: PAGE }],
      reasoning: 'A ported artifact page with a video and images',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);

    // The upload URL: single use, on the dashboard host, with a curl line.
    const grant = await uploadUrl('film.mp4', film.length, 'video/mp4');
    expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
    const g = grant.json as unknown as UploadUrl;
    expect(g.method).toBe('PUT');
    expect(g.asset_path).toBe('/film.mp4');
    expect(g.upload_url).toMatch(/\/api\/assets\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(g.curl).toContain(`curl -T`);
    expect(g.curl).toContain(g.upload_url);
    expect(g.max_bytes).toBe(100 * MiB);

    const first = await put(g.upload_url, film);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json).toMatchObject({ path: '/film.mp4', size: film.length, type: 'video/mp4', replaced: false });
    const again = await put(g.upload_url, film);
    expect(again.status).toBe(404);
    expect(again.json).toMatchObject({ code: 'upload_token_invalid' });
    expect(again.json.hint).toBeTruthy();

    await upload('poster.jpg', poster);
    await upload('s1.jpg', scene);

    // Range → 206 with Content-Range; the whole file → 200; ETag → 304; past the end → 416.
    const ranged = await hostRequest(app.host, '/film.mp4', { headers: { Range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-99/${film.length}`);
    expect(ranged.headers['content-type']).toBe('video/mp4');
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(ranged.bytes.equals(film.subarray(0, 100))).toBe(true);
    const whole = await hostRequest(app.host, '/film.mp4');
    expect(whole.status).toBe(200);
    expect(whole.bytes.equals(film)).toBe(true);
    const etag = String(whole.headers.etag);
    expect((await hostRequest(app.host, '/film.mp4', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await hostRequest(app.host, '/film.mp4', { headers: { Range: `bytes=${film.length}-` } })).status).toBe(416);

    const img = await hostRequest(app.host, '/s1.jpg');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['x-content-type-options']).toBe('nosniff');

    // The page's CSP: media from the app, the curated frame-src, fonts and styles from https.
    const doc = await hostRequest(app.host, '/');
    expect(doc.status).toBe(200);
    const csp = String(doc.headers['content-security-policy']);
    expect(csp).toContain("media-src 'self' blob: https:");
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://drive.google.com');
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
    expect(csp).toContain("font-src 'self' data: https:");
    expect(csp).toContain("img-src 'self' data: blob: https:");

    const listed = await callTool(mcp.client, 'list_assets', { app_id: app.app_id });
    expect(listed.isError, JSON.stringify(listed.json)).toBe(false);
    expect((listed.json.assets as { path: string }[]).map((a) => a.path).sort()).toEqual(['/film.mp4', '/poster.jpg', '/s1.jpg']);
    expect(listed.json.used_bytes).toBe(film.length + poster.length + scene.length);
  });

  test('a browser loads the video (Range), the poster and s1.jpg; only curated iframes pass the CSP', async ({ browser }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.addInitScript(() => {
        const w = window as unknown as { __violations: { directive: string; blocked: string }[] };
        w.__violations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          w.__violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
        });
      });
      const assetResponses: { path: string; status: number }[] = [];
      tab.on('response', (r) => {
        const u = new URL(r.url());
        if (u.host === app.host && /\.(mp4|jpg)$/.test(u.pathname)) assetResponses.push({ path: u.pathname, status: r.status() });
      });
      await tab.goto(urlOf(app.host), { waitUntil: 'domcontentloaded' });
      await expect(tab.getByRole('heading', { name: 'Family film' })).toBeVisible();

      await expect.poll(() => assetResponses.find((r) => r.path === '/s1.jpg')?.status).toBe(200);
      await expect.poll(() => assetResponses.find((r) => r.path === '/poster.jpg')?.status).toBe(200);
      // The browser fetches the video (a media element asks with Range: bytes=0- → 206).
      await expect.poll(() => assetResponses.find((r) => r.path === '/film.mp4')?.status).toBeDefined();
      expect([200, 206]).toContain(assetResponses.find((r) => r.path === '/film.mp4')!.status);

      // The disallowed iframe is refused by frame-src; the video, the poster,
      // the image, the Google Fonts stylesheet and the YouTube embed are not.
      const violations = () =>
        tab.evaluate(() => (window as unknown as { __violations: { directive: string; blocked: string }[] }).__violations);
      await expect
        .poll(async () => (await violations()).some((v) => v.directive === 'frame-src' && v.blocked.startsWith('https://example.com')))
        .toBe(true);
      const watched = new Set(['media-src', 'img-src', 'style-src', 'style-src-elem', 'font-src', 'frame-src']);
      expect((await violations()).filter((v) => watched.has(v.directive) && !v.blocked.startsWith('https://example.com'))).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('refusals are { code, message, hint }: too large, wrong type, HTML behind .mp4, a path the app holds', async () => {
    skipUnlessLocal();
    const big = await uploadUrl('big.mp4', 100 * MiB + 1);
    expect(big.isError).toBe(true);
    expect(big.json).toMatchObject({ code: 'asset_too_large' });
    expect(big.json.message).toBeTruthy();
    expect(big.json.hint).toBeTruthy();

    const wrongType = await uploadUrl('clip.mp4', 1000, 'text/html');
    expect(wrongType.isError).toBe(true);
    expect(wrongType.json.code).toBe('asset_type_not_allowed');
    expect(wrongType.json.hint).toBeTruthy();

    const badPath = await uploadUrl('page.html', 1000);
    expect(badPath.isError).toBe(true);
    expect(badPath.json.code).toBe('invalid_params');

    // A path the app's own (compiled) file holds: write one, then ask for it.
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'img/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }],
      reasoning: 'A logo file',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    const own = await uploadUrl('img/logo.svg', 100);
    expect(own.isError).toBe(true);
    expect(own.json).toMatchObject({ code: 'asset_path_taken', path: '/img/logo.svg' });
    expect(own.json.hint).toBeTruthy();

    // HTML bytes behind a .mp4 URL: the bytes decide → 415, nothing served.
    const html = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
    const trap = await uploadUrl('trap.mp4', html.length);
    expect(trap.isError, JSON.stringify(trap.json)).toBe(false);
    const refused = await put((trap.json as unknown as UploadUrl).upload_url, html);
    expect(refused.status).toBe(415);
    expect(refused.json).toMatchObject({ code: 'asset_type_not_allowed' });
    expect(refused.json.message).toBeTruthy();
    expect(refused.json.hint).toBeTruthy();
    expect((await hostRequest(app.host, '/trap.mp4')).status).toBe(404);

    // A body longer than declared → asset_size_mismatch.
    const short = await uploadUrl('short.jpg', 100);
    expect(short.isError, JSON.stringify(short.json)).toBe(false);
    const mismatch = await put((short.json as unknown as UploadUrl).upload_url, fakeJpeg(200));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json).toMatchObject({ code: 'asset_size_mismatch' });
  });

  test('the dashboard Assets tab lists the assets and deletes one; the preview host then answers 404', async () => {
    skipUnlessLocal();
    const tab = await owner.newPage();
    const base = `${BASE_URL_WEB}/workspaces/${app.workspace}/apps/${app.slug}/assets`;
    await tab.goto(base);
    await expect(tab.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
    const rows = tab.getByTestId('asset-row');
    await expect(rows).toHaveCount(3);
    await expect(tab.locator('[data-testid="asset-row"][data-path="/s1.jpg"]')).toContainText('image/jpeg');
    await expect(tab.locator('[data-testid="asset-row"][data-path="/film.mp4"]')).toContainText('video/mp4');

    const s1 = tab.locator('[data-testid="asset-row"][data-path="/s1.jpg"]');
    await s1.getByTestId('asset-delete').click();
    await tab.getByTestId('asset-delete-confirm').click();
    await expect(rows).toHaveCount(2);
    await expect(tab.locator('[data-testid="asset-row"][data-path="/s1.jpg"]')).toHaveCount(0);

    expect((await hostRequest(app.host, '/s1.jpg')).status).toBe(404);
    expect((await hostRequest(app.host, '/film.mp4', { headers: { Range: 'bytes=0-9' } })).status).toBe(206);

    // Upload from the tab: pick a file, keep the suggested path, the XHR PUT
    // to the same single-use upload URL, then the list refreshes.
    const s2 = fakeJpeg(4096);
    await tab.getByTestId('asset-file').setInputFiles({ name: 's2.jpg', mimeType: 'image/jpeg', buffer: s2 });
    await expect(tab.getByTestId('asset-path')).toHaveValue('s2.jpg');
    await tab.getByTestId('asset-path').fill('img/s2.jpg');
    await tab.getByTestId('asset-upload').click();
    await expect(tab.getByTestId('asset-upload-done')).toContainText('/img/s2.jpg');
    await expect(tab.locator('[data-testid="asset-row"][data-path="/img/s2.jpg"]')).toContainText('image/jpeg');
    const served = await hostRequest(app.host, '/img/s2.jpg');
    expect(served.status).toBe(200);
    expect(served.bytes.equals(s2)).toBe(true);
    await tab.close();
  });
});
