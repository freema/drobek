import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { expect, test } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * M1-07 (NSO-290): get_logs end to end on the local stack.
 *
 *  - runtime: a page on the PREVIEW host throws (uncaught error + unhandled
 *    rejection) in a real browser → the beacon the compiler put in front of
 *    every entry POSTs to `/__drobek/v1/_beacon` → `get_logs('runtime')`
 *    shows it within 5 s, the e-mail in the message redacted, inside the
 *    untrusted envelope;
 *  - compile: the last compiles with ok / errors / version (≤ 50);
 *  - requests: today's totals + module calls by status class (hello: 2xx, 4xx);
 *  - the beacon: 9 KiB (declared or chunked) → 413 and the server keeps
 *    answering (the PHY-76 #10 regression); a cross-origin POST → 403.
 */

interface Created {
  app_id: string;
  slug: string;
}

interface RuntimeEntry {
  type: string;
  message: string;
  count: number;
  url: string;
  file_hint: string | null;
}

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const LEAKED_EMAIL = `ana.e2e-${STAMP}@example.com`;

/** A page that renders, then fails twice: an uncaught error and an unhandled rejection. */
const FAILING_MAIN = [
  "import './styles.css';",
  '',
  "const root = document.getElementById('root')!;",
  "root.innerHTML = '<h1>Logs demo ready</h1>';",
  '',
  'function checkout(): void {',
  `  throw new TypeError('checkout failed for ${LEAKED_EMAIL}');`,
  '}',
  '',
  'setTimeout(checkout, 50);',
  "setTimeout(() => { void Promise.reject(new Error('async boom')); }, 60);",
  '',
].join('\n');

/** A syntax error on line 6 (esbuild reports 1-based lines). */
const BROKEN_MAIN = [
  "import './styles.css';",
  '',
  "const root = document.getElementById('root')!;",
  '',
  'function broken() {',
  '  const = 1;',
  '}',
  '',
].join('\n');

/** POST a body to the beacon of `host` in 1 KiB chunks (no Content-Length). */
function chunkedPost(host: string, path: string, body: Buffer): Promise<number> {
  const scheme = APPS_URL_SCHEME === 'https' ? 'https' : 'http';
  const m = /^(.*?)(?::(\d+))?$/.exec(host)!;
  const hostname = m[1];
  const port = m[2] ? Number(m[2]) : scheme === 'https' ? 443 : 80;
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost');
  const send = scheme === 'https' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: loopback ? '127.0.0.1' : hostname,
        port,
        path,
        method: 'POST',
        headers: { Host: host, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        setHost: false,
        ...(scheme === 'https' ? { servername: hostname } : {}),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    // The server may answer 413 and stop reading before the last chunk.
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve(-1) : reject(err)));
    for (let i = 0; i < body.length; i += 1024) req.write(body.subarray(i, i + 1024));
    req.end();
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('get_logs — runtime errors, compile history, request stats (M1-07) @local', () => {
  let mcp: McpClient;
  let app: Created;
  let host: string;

  test.afterAll(async () => {
    await mcp?.client.close();
  });

  test("runtime: an error on the preview host is in get_logs('runtime') within 5 s, the e-mail redacted", async ({ page, request, browser }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'get-logs', scope: FULL_SCOPE });
    // A short slug: long [A-Za-z0-9_-] runs (≥ 32) are redacted as opaque tokens.
    app = (await callTool(mcp.client, 'create_app', { name: 'Logs demo', template: 'react-ts' })).json as unknown as Created;
    host = previewHost(app.slug);

    const w = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.tsx', content: FAILING_MAIN }],
      reasoning: 'A page that fails at runtime',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    // The compiler put the beacon in front of the entry.
    const mainJs = await hostRequest(host, '/main.js');
    expect(mainJs.status).toBe(200);
    const beaconUrl = /^import "(\/__drobek\/beacon\.js\?v=[0-9a-f]{16})";/.exec(mainJs.body)?.[1];
    expect(beaconUrl, mainJs.body.slice(0, 200)).toBeTruthy();
    const script = await hostRequest(host, beaconUrl!);
    expect(script.status).toBe(200);
    expect(String(script.headers['cache-control'])).toContain('immutable');

    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.goto(urlOf(host));
      await expect(tab.getByRole('heading', { name: 'Logs demo ready' })).toBeVisible();
      const loadedAt = Date.now();

      let entries: RuntimeEntry[] = [];
      let text = '';
      await expect
        .poll(
          async () => {
            const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'runtime' });
            expect(r.isError, JSON.stringify(r.json)).toBe(false);
            entries = r.json.entries as RuntimeEntry[];
            text = r.text;
            return entries.some((e) => e.message.includes('checkout failed')) && entries.some((e) => e.type === 'unhandledrejection');
          },
          { timeout: 5_000, intervals: [250] }
        )
        .toBe(true);
      expect(Date.now() - loadedAt).toBeLessThan(5_000);

      const err = entries.find((e) => e.message.includes('checkout failed'))!;
      expect(err.type).toBe('error');
      expect(err.message).toContain('TypeError');
      expect(err.message).toContain('[redacted-email]');
      expect(err.message).not.toContain(LEAKED_EMAIL);
      expect(err.url).toContain(host);
      expect(err.file_hint).toContain('main.js');
      expect(entries.find((e) => e.type === 'unhandledrejection')!.message).toContain('async boom');

      // Untrusted: the flag + the nonce envelope, and the address never leaks.
      expect(text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
      const nonce = /<untrusted-app-logs [^>]*nonce="([0-9a-f]{16})">/.exec(text)?.[1];
      expect(nonce).toBeTruthy();
      expect(text.trimEnd()).toContain(`</untrusted-app-logs nonce="${nonce}">`);
      expect(text).not.toContain(LEAKED_EMAIL);
    } finally {
      await ctx.close();
    }
  });

  test('compile: the last compiles with ok / errors / version', async () => {
    skipUnlessLocal();
    const broken = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [{ path: 'src/main.tsx', content: BROKEN_MAIN }],
      reasoning: 'Break the build',
    });
    expect((broken.json.compile as { ok: boolean }).ok).toBe(false);

    const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'compile' });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    expect(r.json).toMatchObject({ app_id: app.app_id, kind: 'compile', untrusted: true });
    const entries = r.json.entries as { version: number | null; ok: boolean; trigger: string; errors: { file: string; line: number; text: string }[] }[];
    expect(entries.length).toBeLessThanOrEqual(50);
    expect(entries.map((e) => [e.version, e.ok, e.trigger])).toEqual([
      [3, false, 'write_files'],
      [2, true, 'write_files'],
      [1, true, 'create_app'],
    ]);
    expect(entries[0].errors[0]).toMatchObject({ file: 'src/main.tsx', line: 6 });
    expect(entries[1].errors).toEqual([]);
    expect(r.text.startsWith('UNTRUSTED CONTENT:')).toBe(true);
  });

  test('requests: daily totals and 2xx / 4xx per module', async () => {
    skipUnlessLocal();
    expect((await hostRequest(host, '/')).status).toBe(200);
    expect((await hostRequest(host, '/__drobek/v1/hello')).status).toBe(200);
    expect((await hostRequest(host, '/__drobek/v1/hello/nope')).status).toBe(404);
    // A mutation without the SDK header → 403 (csrf_rejected), a 4xx of hello.
    expect((await hostRequest(host, '/__drobek/v1/hello/wave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(403);

    const today = new Date().toISOString().slice(0, 10);
    type Day = { day: string; requests: number; count_5xx: number; count_404: number; modules: Record<string, Record<string, number>> };
    let day: Day | undefined;
    await expect
      .poll(
        async () => {
          const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'requests' });
          expect(r.isError, JSON.stringify(r.json)).toBe(false);
          expect(r.json.untrusted).toBe(true);
          day = (r.json.entries as Day[]).find((d) => d.day === today);
          return (day?.modules.hello?.['4xx'] ?? 0) >= 2 && (day?.modules.hello?.['2xx'] ?? 0) >= 1;
        },
        { timeout: 5_000, intervals: [250] }
      )
      .toBe(true);
    expect(day!.requests).toBeGreaterThanOrEqual(4);
    expect(Object.keys(day!.modules.hello).sort()).toEqual(['2xx', '3xx', '4xx', '5xx']);
    expect(typeof day!.count_5xx).toBe('number');
    // Not an active module → never a row.
    expect(day!.modules._beacon).toBeUndefined();
  });

  test('beacon: 9 KiB → 413 (declared and chunked), the server keeps answering; cross-origin → 403', async ({ request }) => {
    skipUnlessLocal();
    const nine = Buffer.alloc(9 * 1024, 0x78);
    const declared = await hostRequest(host, '/__drobek/v1/_beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(nine.length) },
      body: nine.toString('utf8'),
    });
    expect(declared.status).toBe(413);
    expect([413, -1]).toContain(await chunkedPost(host, '/__drobek/v1/_beacon', nine));
    const burst = await Promise.all(Array.from({ length: 5 }, () => chunkedPost(host, '/__drobek/v1/_beacon', nine)));
    for (const s of burst) expect([413, -1]).toContain(s);

    // Still alive: the app host and the dashboard answer.
    expect((await hostRequest(host, '/')).status).toBe(200);
    expect((await request.get(`${BASE_URL_WEB}/health`)).status()).toBe(200);

    const foreign = await hostRequest(host, '/__drobek/v1/_beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ events: [{ type: 'error', message: 'forged' }] }),
    });
    expect(foreign.status).toBe(403);
    const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'runtime' });
    expect(JSON.stringify(r.json.entries)).not.toContain('forged');
  });
});
