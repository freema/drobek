import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf, type Raw } from './helpers/apps-host';
import { pollLoginCode, skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * M1-05 (NSO-296): the built-in platform module `files` end to end on the
 * apps host (DROBEK_MODULES=…,data,files in both composes, FILES_MAX_BYTES
 * 10 MiB, FILES_QUOTA_PER_APP 2 MiB). Every test works on its own fresh app:
 *
 *  - skill_info('files') carries the <LoginGate> photo uploader; it compiles
 *    via write_files and uploads, shows and deletes a photo in a browser;
 *  - upload: public needs the owner's confirmation; a PNG is served with
 *    its sniffed type, nosniff, inline, the `sandbox` CSP after the app CSP,
 *    a 5-minute revalidated public cache and an ETag (304); an SVG is served
 *    as an attachment (sandboxed too); an HTML page named .png
 *    → 415 unsupported_type; 10 MiB + 1 B → 413 (declared and chunked) with
 *    nothing on disk; no X-Drobek-SDK → 403;
 *  - read: user → a visitor's GET is 401, the signed-in user's 200;
 *  - the same bytes in two apps are stored once; deleting one app's file
 *    keeps the blob until the other app's file is deleted too;
 *  - the 2 MiB quota → 409 quota_exceeded;
 *  - NSO-324: one signed-in user's upload flood hits their own bucket
 *    (FILES_UPLOADS_PER_PRINCIPAL_PER_MIN, 20/min) while another user of the
 *    app still uploads.
 *
 * Disk assertions run `docker compose exec -T drobek …` (the compose project
 * of this run: the dev stack, or the one scripts/e2e-image.sh exports).
 */

interface Created {
  app_id: string;
  slug: string;
  workspace: string;
}

interface StoredFile {
  id: string;
  url: string;
  size: number;
  type: string;
  name: string;
  owner: string | null;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECURE = APPS_URL_SCHEME === 'https';
const COOKIE = SECURE ? '__Host-drobek_eu' : 'drobek_eu';
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const MiB = 1024 * 1024;
const BOUNDARY = '----drobekE2eFiles';

/** A real 1×1 PNG (decodes in a browser). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG magic bytes + random padding: sniffed as image/png, unique per call. */
const png = (bytes: number): Buffer => Buffer.concat([PNG_SIG, randomBytes(bytes - PNG_SIG.length)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
const HTML_AS_PNG = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');

const email = (who: string): string => `e2e-files-${who}-${STAMP}@example.com`;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function sdkHeaders(host: string, cookie?: string): Record<string, string> {
  return { Origin: urlOf(host), 'X-Drobek-SDK': '1', ...(cookie ? { Cookie: cookie } : {}) };
}

function multipart(content: Buffer, filename: string, type: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function upload(
  host: string,
  content: Buffer,
  opts: { filename?: string; type?: string; cookie?: string; chunked?: boolean; sdk?: boolean } = {}
): Promise<Raw> {
  return hostRequest(host, '/__drobek/v1/files', {
    method: 'POST',
    headers: {
      ...(opts.sdk === false ? { Origin: urlOf(host) } : sdkHeaders(host, opts.cookie)),
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      ...(opts.chunked ? { 'Transfer-Encoding': 'chunked' } : {}),
    },
    body: multipart(content, opts.filename ?? 'photo.png', opts.type ?? 'image/png'),
  });
}

function get(host: string, id: string, opts: { cookie?: string; headers?: Record<string, string> } = {}): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1/files/${id}`, {
    headers: { ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers },
  });
}

function remove(host: string, id: string, cookie?: string): Promise<Raw> {
  return hostRequest(host, `/__drobek/v1/files/${id}`, { method: 'DELETE', headers: sdkHeaders(host, cookie) });
}

function json<T = Record<string, unknown>>(r: Raw): T {
  return JSON.parse(r.body) as T;
}

/** A shell command inside the drobek container of THIS compose project. */
function inDrobek(cmd: string): string {
  return execSync(`docker compose exec -T drobek sh -c ${JSON.stringify(cmd)}`, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** Every stored blob and temp file under FILES_DIR (content-addressed paths and tmp/). */
const filesOnDisk = (): string[] => inDrobek('find /data/files -type f | sort').split('\n').filter(Boolean);
const blobOnDisk = (sha: string): boolean => filesOnDisk().includes(`/data/files/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`);

/** send-code → the Mailpit code → verify on `host`; the Cookie header value and the user id. */
async function signIn(request: APIRequestContext, host: string, address: string): Promise<{ cookie: string; id: string; value: string }> {
  const headers = { ...sdkHeaders(host), 'Content-Type': 'application/json' };
  const sent = await hostRequest(host, '/__drobek/v1/auth/send-code', { method: 'POST', headers, body: JSON.stringify({ email: address }) });
  expect(sent.status, sent.body).toBe(200);
  const code = await pollLoginCode(request, address);
  const verified = await hostRequest(host, '/__drobek/v1/auth/verify', { method: 'POST', headers, body: JSON.stringify({ email: address, code }) });
  expect(verified.status, verified.body).toBe(200);
  const sc = verified.headers['set-cookie'];
  const setCookie = (Array.isArray(sc) ? sc : sc ? [sc] : []).join('\n');
  const m = new RegExp(`(${COOKIE}=([0-9a-f]{64}))`).exec(setCookie);
  expect(m, setCookie).toBeTruthy();
  return { cookie: m![1], value: m![2], id: json<{ user: { id: string } }>(verified).user.id };
}

test.describe.configure({ mode: 'serial' });

test.describe('platform module files — end-user uploads (M1-05) @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  async function configure(appId: string, module: string, config: unknown) {
    const r = await callTool(mcp.client, 'configure_module', { app_id: appId, module, config });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    return r.json;
  }

  async function confirm(appId: string, module: string) {
    const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${appId}/modules/${module}/confirm`, {
      headers: { Origin: BASE_URL_WEB },
      maxRedirects: 0,
    });
    expect(ok.status(), await ok.text()).toBe(200);
  }

  async function freshApp(name: string, template = 'html'): Promise<Created & { host: string }> {
    const created = (await callTool(mcp.client, 'create_app', { name: `${name} ${STAMP}`, template })).json as unknown as Created;
    return { ...created, host: previewHost(created.slug) };
  }

  /** A fresh app whose end users sign in (auth allow-list) — `who` is signed in on it. */
  async function appWithUser(request: APIRequestContext, name: string, who: string, files?: unknown) {
    const app = await freshApp(name);
    await configure(app.app_id, 'auth', { allow: { emails: [email(who)] } });
    if (files !== undefined) expect(await configure(app.app_id, 'files', files)).toMatchObject({ applied: true });
    const user = await signIn(request, app.host, email(who));
    return { app, user };
  }

  test("skill_info('files'): the LoginGate photo uploader compiles, uploads, shows and deletes a photo in a browser", async ({ page, request, browser }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'files-module', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });

    const info = await callTool(mcp.client, 'skill_info', { name: 'files' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'files', kind: 'module' });
    const content = String(info.json.content);
    expect(content.split('\n').length).toBeLessThanOrEqual(150);
    expect((info.json.limits as { name: string }[]).map((l) => l.name)).toEqual(
      expect.arrayContaining(['FILES_MAX_BYTES', 'FILES_QUOTA_PER_APP', 'FILES_UPLOAD_RATE_LIMIT'])
    );
    const example = /```tsx\n([\s\S]*?)```/.exec(content)![1];
    expect(example).toContain('<LoginGate');
    expect(example).toContain('drobek.files.upload(file)');

    const app = await freshApp('Files photos', 'react-ts');
    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.tsx', content: example }],
      reasoning: 'Photo uploader (files skill example)',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);
    await configure(app.app_id, 'auth', { allow: { emails: [email('ana')] } });
    const ana = await signIn(request, app.host, email('ana'));

    const ctx = await browser.newContext();
    try {
      await ctx.addCookies([{ name: COOKIE, value: ana.value, url: urlOf(app.host) }]);
      const tab = await ctx.newPage();
      await tab.goto(urlOf(app.host));
      await expect(tab.getByRole('heading', { name: 'My photos' })).toBeVisible();
      await tab.getByLabel('Upload a photo').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: TINY_PNG });
      const img = tab.locator('li img');
      await expect(img).toHaveCount(1);
      await expect(img).toHaveAttribute('alt', 'dot.png');
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
      await tab.getByRole('button', { name: 'Delete' }).click();
      await expect(tab.locator('li')).toHaveCount(0);
      await expect(tab.getByRole('alert')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('upload: public waits for the owner; PNG inline + nosniff + ETag; SVG as attachment; HTML named .png → 415; 10 MiB + 1 B → 413, nothing on disk', async () => {
    skipUnlessLocal();
    const app = await freshApp('Files public');

    const held = await configure(app.app_id, 'files', { rules: { upload: 'public', read: 'public' } });
    expect(held.applied).toBe(false);
    expect(held.pending_confirmation).toEqual([
      'files.rules.upload: "user" → "public" (anyone, signed in or not, may upload files into the app\'s storage)',
    ]);
    expect(String(held.confirm_url)).toContain(`/apps/${app.slug}/modules/files`);
    const early = await upload(app.host, TINY_PNG);
    expect(early.status, early.body).toBe(401);
    expect(json(early)).toMatchObject({ error: 'unauthorized', hint: "skill_info('files')" });
    await confirm(app.app_id, 'files');

    // A PNG under a hostile name and a lying declared type: stored as what its bytes are.
    const made = await upload(app.host, TINY_PNG, { filename: '../../dot.png', type: 'text/html' });
    expect(made.status, made.body).toBe(201);
    const f = json<StoredFile>(made);
    expect(f).toMatchObject({ url: `/__drobek/v1/files/${f.id}`, size: TINY_PNG.length, type: 'image/png', name: 'dot.png', owner: null });
    const got = await get(app.host, f.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(TINY_PNG)).toBe(true);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(String(got.headers['content-disposition'])).toMatch(/^inline; filename="dot\.png"/);
    // NSO-325: the URL names the file, not its content — shared caches revalidate after 5 minutes.
    expect(got.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    // NSO-325: the sandbox backstop is a second policy after the app CSP, never replacing it.
    expect(String(got.headers['content-security-policy'])).toMatch(/^default-src 'self'.*, sandbox$/);
    expect(got.headers.etag).toBe(`"${sha256(TINY_PNG)}"`);
    expect((await get(app.host, f.id, { headers: { 'If-None-Match': String(got.headers.etag) } })).status).toBe(304);
    expect(blobOnDisk(sha256(TINY_PNG))).toBe(true);

    const svg = await upload(app.host, SVG, { filename: 'logo.svg', type: 'image/svg+xml' });
    expect(svg.status, svg.body).toBe(201);
    const svgGot = await get(app.host, json<StoredFile>(svg).id);
    expect(svgGot.headers['content-type']).toBe('image/svg+xml');
    expect(svgGot.headers['x-content-type-options']).toBe('nosniff');
    expect(String(svgGot.headers['content-security-policy'])).toMatch(/, sandbox$/);
    expect(String(svgGot.headers['content-disposition'])).toMatch(/^attachment; filename="logo\.svg"/);

    const before = filesOnDisk();
    const html = await upload(app.host, HTML_AS_PNG, { filename: 'cat.png', type: 'image/png' });
    expect(html.status, html.body).toBe(415);
    expect(json(html)).toMatchObject({ error: 'unsupported_type', hint: "skill_info('files')" });

    const tooBig = png(10 * MiB + 1);
    const declared = await upload(app.host, tooBig);
    expect(declared.status, declared.body).toBe(413);
    expect(json(declared)).toMatchObject({ error: 'payload_too_large', details: { limit: 'FILES_MAX_BYTES', value: 10 * MiB } });
    const chunked = await upload(app.host, tooBig, { chunked: true });
    expect(chunked.status, chunked.body).toBe(413);
    expect(json(chunked)).toMatchObject({ error: 'payload_too_large' });
    expect(filesOnDisk()).toEqual(before);
    expect(filesOnDisk().filter((p) => p.startsWith('/data/files/tmp/'))).toEqual([]);

    const csrf = await upload(app.host, TINY_PNG, { sdk: false });
    expect(csrf.status).toBe(403);
    // Anonymous uploads have no owner: only the app's admin may delete them.
    expect((await remove(app.host, f.id)).status).toBe(401);
  });

  test('read: user — a visitor gets 401, the signed-in user the file (private cache)', async ({ request }) => {
    skipUnlessLocal();
    const { app, user } = await appWithUser(request, 'Files private', 'bob');
    const bytes = png(2000);
    const anonUpload = await upload(app.host, bytes);
    expect(anonUpload.status).toBe(401);
    const made = await upload(app.host, bytes, { cookie: user.cookie });
    expect(made.status, made.body).toBe(201);
    const f = json<StoredFile>(made);
    expect(f.owner).toBe(user.id);

    const anon = await get(app.host, f.id);
    expect(anon.status).toBe(401);
    expect(json(anon)).toMatchObject({ error: 'unauthorized', hint: "skill_info('files')" });
    expect((await get(app.host, 'doesnotexist00')).status).toBe(401);
    const mine = await get(app.host, f.id, { cookie: user.cookie });
    expect(mine.status).toBe(200);
    expect(mine.bytes.equals(bytes)).toBe(true);
    expect(mine.headers['cache-control']).toBe('private, no-cache');
    expect((await get(app.host, 'doesnotexist00', { cookie: user.cookie })).status).toBe(404);
  });

  test('the same bytes in two apps are stored once; the blob goes only with the last file that references it', async ({ request }) => {
    skipUnlessLocal();
    const bytes = png(4096);
    const sha = sha256(bytes);
    const x = await appWithUser(request, 'Files dedup X', 'cleo', { rules: { read: 'public' } });
    const y = await appWithUser(request, 'Files dedup Y', 'cleo', { rules: { read: 'public' } });

    const fx = json<StoredFile>(await upload(x.app.host, bytes, { cookie: x.user.cookie }));
    const fy = json<StoredFile>(await upload(y.app.host, bytes, { cookie: y.user.cookie }));
    expect(fx.id).not.toBe(fy.id);
    expect(filesOnDisk().filter((p) => p.endsWith(sha))).toHaveLength(1);
    // Another app's id is not found on this app's host.
    expect((await get(x.app.host, fy.id)).status).toBe(404);

    const delX = await remove(x.app.host, fx.id, x.user.cookie);
    expect(delX.status, delX.body).toBe(200);
    expect(json(delX)).toEqual({ id: fx.id, deleted: true });
    expect((await get(x.app.host, fx.id)).status).toBe(404);
    expect(blobOnDisk(sha)).toBe(true);
    const still = await get(y.app.host, fy.id);
    expect(still.status).toBe(200);
    expect(still.bytes.equals(bytes)).toBe(true);

    expect((await remove(y.app.host, fy.id, y.user.cookie)).status).toBe(200);
    expect(blobOnDisk(sha)).toBe(false);
  });

  test('FILES_QUOTA_PER_APP = 2 MiB: the upload that would pass it → 409 quota_exceeded, nothing stored', async ({ request }) => {
    skipUnlessLocal();
    const { app, user } = await appWithUser(request, 'Files quota', 'dora');
    for (let i = 0; i < 2; i++) {
      const r = await upload(app.host, png(1_000_000), { cookie: user.cookie });
      expect(r.status, r.body).toBe(201);
    }
    const before = filesOnDisk();
    const over = await upload(app.host, png(200_000), { cookie: user.cookie });
    expect(over.status, over.body).toBe(409);
    expect(json(over)).toMatchObject({
      error: 'quota_exceeded',
      details: { limit: 'FILES_QUOTA_PER_APP', value: 2 * MiB },
      hint: "skill_info('files')",
    });
    expect(filesOnDisk()).toEqual(before);
    // Still room for a small one.
    expect((await upload(app.host, png(90_000), { cookie: user.cookie })).status).toBe(201);
  });

  test("NSO-324: one user's upload flood hits their own bucket (FILES_UPLOADS_PER_PRINCIPAL_PER_MIN); another user still uploads", async ({ request }) => {
    skipUnlessLocal();
    const app = await freshApp('Files flood');
    await configure(app.app_id, 'auth', { allow: { emails: [email('fay'), email('gus')] } });
    const fay = await signIn(request, app.host, email('fay'));
    const gus = await signIn(request, app.host, email('gus'));
    let refused: Raw | null = null;
    // 20 per minute (default); a window may roll over once while looping.
    for (let i = 0; i < 45 && !refused; i++) {
      const r = await upload(app.host, png(200), { cookie: fay.cookie });
      if (r.status === 429) refused = r;
      else expect(r.status, r.body).toBe(201);
    }
    expect(refused, 'no 429 within 45 uploads').not.toBeNull();
    expect(json(refused!)).toMatchObject({ error: 'rate_limited', details: { limit: 'FILES_UPLOADS_PER_PRINCIPAL_PER_MIN', value: 20 } });
    expect((await upload(app.host, png(200), { cookie: gus.cookie })).status).toBe(201);
  });
});
