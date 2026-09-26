import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * NSO-359: porting a Claude artifact to drobek — the procedure of the
 * `port-artifact` skill, done here by the test the way an agent does it:
 *
 *  - the fixture `tests-eval/fixtures/artifact/` is a multi-file artifact
 *    (`index.html` with relative paths, `style.css`, `chapters.js`, a tiny
 *    H.264 `film.mp4`, `poster.jpg`, `s1.jpg`, `s2.jpg`) — the same folder the
 *    manual agent eval (`task eval -- --only d`) hands a fresh agent;
 *  - create_app (html) → every text file with ONE write_files, content and
 *    paths unchanged → every binary with create_asset_upload at the SAME
 *    relative path + one PUT of its bytes (what `curl -T` does; the upload
 *    URL needs no other credential, so the PUT carries no cookie);
 *  - the preview serves the page (200) with its paths untouched,
 *    `film.mp4` with Range → 206, `s1.jpg` → 200 image/jpeg, the script and
 *    the stylesheet as written; list_assets shows every binary with its size;
 *  - in a browser the chapter script runs and the video loads its metadata
 *    and seeks (when the browser plays H.264).
 */

interface Created {
  app_id: string;
  slug: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(repoRoot, 'tests-eval', 'fixtures', 'artifact');
/** What write_files takes (text); everything else in the folder is an asset. */
const TEXT_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md']);
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

const fixtureFiles = readdirSync(FIXTURE).sort();
const textFiles = fixtureFiles.filter((f) => TEXT_EXTS.has(extname(f)));
const binaries = fixtureFiles.filter((f) => !TEXT_EXTS.has(extname(f)));
const bytesOf = (f: string): Buffer => readFileSync(join(FIXTURE, f));

/** The upload URL on THIS target's dashboard origin (the tool builds it from PUBLIC_APP_URL). */
const onDashboard = (url: string): string => `${BASE_URL_WEB}${new URL(url).pathname}`;

test.describe.configure({ mode: 'serial' });

test.describe('port a Claude artifact — text via write_files, binaries via upload URLs (NSO-359) @local', () => {
  let mcp: McpClient;
  let app: Created & { host: string };

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test('the fixture is a multi-file artifact with relative paths', () => {
    expect(textFiles).toEqual(['chapters.js', 'index.html', 'style.css']);
    expect(binaries).toEqual(['film.mp4', 'poster.jpg', 's1.jpg', 's2.jpg']);
    const html = bytesOf('index.html').toString('utf8');
    for (const ref of ['src="film.mp4"', 'poster="poster.jpg"', 'src="s1.jpg"', 'src="s2.jpg"', 'src="chapters.js"', 'href="style.css"']) {
      expect(html, ref).toContain(ref);
    }
    expect(bytesOf('film.mp4').subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  test('create_app → write_files (unchanged) → create_asset_upload + PUT per binary → the preview serves them', async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'port-artifact', scope: FULL_SCOPE });
    const created = (await callTool(mcp.client, 'create_app', { name: `Ported artifact ${STAMP}`, template: 'html' })).json as unknown as Created;
    app = { ...created, host: previewHost(created.slug) };

    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: textFiles.map((path) => ({ path, content: bytesOf(path).toString('utf8') })),
      reasoning: 'Port the artifact: its text files, paths unchanged',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    for (const path of binaries) {
      const body = bytesOf(path);
      const grant = await callTool(mcp.client, 'create_asset_upload', { app_id: app.app_id, path, size: body.length });
      expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
      expect(grant.json.asset_path).toBe(`/${path}`);
      expect(String(grant.json.curl)).toContain('curl -T');
      // No cookie, no bearer: the single-use URL is the only credential.
      const put = await request.put(onDashboard(String(grant.json.upload_url)), {
        data: body,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      expect(put.status(), await put.text()).toBe(201);
      expect(await put.json()).toMatchObject({ path: `/${path}`, size: body.length });
    }

    const listed = await callTool(mcp.client, 'list_assets', { app_id: app.app_id });
    expect(listed.isError, JSON.stringify(listed.json)).toBe(false);
    const assets = (listed.json.assets as { path: string; size: number }[]).map((a) => [a.path, a.size]).sort();
    expect(assets).toEqual(binaries.map((f) => [`/${f}`, bytesOf(f).length]));

    // The page: 200, its relative paths untouched.
    const doc = await hostRequest(app.host, '/');
    expect(doc.status).toBe(200);
    for (const ref of ['src="film.mp4"', 'poster="poster.jpg"', 'src="s1.jpg"', 'src="chapters.js"', 'href="style.css"']) {
      expect(doc.body, ref).toContain(ref);
    }

    // The video seeks: Range → 206 with the exact bytes.
    const film = bytesOf('film.mp4');
    const ranged = await hostRequest(app.host, '/film.mp4', { headers: { Range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-type']).toBe('video/mp4');
    expect(ranged.headers['content-range']).toBe(`bytes 0-99/${film.length}`);
    expect(ranged.bytes.equals(film.subarray(0, 100))).toBe(true);

    const s1 = await hostRequest(app.host, '/s1.jpg');
    expect(s1.status).toBe(200);
    expect(s1.headers['content-type']).toBe('image/jpeg');
    expect(s1.bytes.equals(bytesOf('s1.jpg'))).toBe(true);
    expect((await hostRequest(app.host, '/poster.jpg')).status).toBe(200);

    // The script and the stylesheet are served as written.
    const script = await hostRequest(app.host, '/chapters.js');
    expect(script.status).toBe(200);
    expect(script.body).toBe(bytesOf('chapters.js').toString('utf8'));
    expect((await hostRequest(app.host, '/style.css')).status).toBe(200);
  });

  test('in a browser the chapters render, the images load and the video plays and seeks', async ({ browser }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      const errors: string[] = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      const media: { path: string; status: number }[] = [];
      tab.on('response', (r) => {
        const u = new URL(r.url());
        if (u.host === app.host && /\.(mp4|jpg)$/.test(u.pathname)) media.push({ path: u.pathname, status: r.status() });
      });
      await tab.goto(urlOf(app.host), { waitUntil: 'load' });
      await expect(tab.getByRole('heading', { name: "Summer at Grandma's" })).toBeVisible();
      await expect(tab.getByRole('navigation', { name: 'Chapters' }).getByRole('button')).toHaveCount(2);
      await expect.poll(() => media.find((m) => m.path === '/s1.jpg')?.status).toBe(200);
      await expect.poll(() => media.find((m) => m.path === '/s2.jpg')?.status).toBe(200);
      await expect.poll(() => media.find((m) => m.path === '/film.mp4')?.status).toBeDefined();
      expect([200, 206]).toContain(media.find((m) => m.path === '/film.mp4')!.status);

      const h264 = await tab.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'));
      if (h264 === '') {
        test.info().annotations.push({ type: 'note', description: 'this browser build plays no H.264 — video playback not asserted' });
      } else {
        await expect
          .poll(() => tab.evaluate(() => (document.getElementById('film') as HTMLVideoElement).readyState))
          .toBeGreaterThanOrEqual(1);
        expect(await tab.evaluate(() => (document.getElementById('film') as HTMLVideoElement).duration)).toBeCloseTo(2, 0);
        await tab.evaluate(() => {
          (document.getElementById('film') as HTMLVideoElement).muted = true;
        });
        await tab.getByRole('button', { name: 'The lake' }).click();
        await expect
          .poll(() => tab.evaluate(() => (document.getElementById('film') as HTMLVideoElement).currentTime))
          .toBeGreaterThanOrEqual(1);
      }
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
