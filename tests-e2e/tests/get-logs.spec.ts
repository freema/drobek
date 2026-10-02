import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { expect, test } from '@playwright/test';
import { APPS_URL_SCHEME, BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * get_logs end to end on the local stack.
 *
 *  - runtime: a page on the PREVIEW host throws (uncaught error + unhandled
 *    rejection) in a real browser → the beacon the compiler put in front of
 *    every entry POSTs to `/__drobek/v1/_beacon` → `get_logs('runtime')`
 *    shows it within 5 s, the e-mail in the message redacted, inside the
 *    untrusted envelope;
 *  - compile: the last compiles with ok / errors / version (≤ 50);
 *  - requests: today's totals + module calls by status class (hello: 2xx, 4xx);
 *    a flush never lowers a day Postgres already holds (Redis restarted);
 *  - the beacon: 9 KiB (declared or chunked) → 413 and the server keeps
 *    answering; a cross-origin POST → 403;
 *  - the page URL is stored as origin + path — the SDK never sends
 *    the query string or fragment (`?code=…`), and a client that does has
 *    them stripped by the server;
 *  - the render signal: every HTML response names its version in
 *    `Server-Timing`; get_app's `render` and the get_logs envelope count the
 *    newest version's page loads (0 before anyone opened it) and its browser
 *    errors — an image that failed to load and a fetch the CSP blocked,
 *    reported with the version and without their query strings;
 *    `"beacon": false` in drobek.json turns it off.
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
  version: number | null;
}

interface Render {
  version: number;
  beacon: boolean;
  page_loads: number;
  errors: number;
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

/** A page that renders, then shows an image that is not there and fetches an origin the app CSP blocks. */
const RENDER_MAIN = [
  "import './styles.css';",
  '',
  "const root = document.getElementById('root')!;",
  'root.innerHTML = \'<h1>Render demo ready</h1><img alt="logo" src="/missing-logo.png?v=secret">\';',
  "fetch('https://api.example.com/v1/items?token=abc').catch(() => undefined);",
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

test.describe('get_logs — runtime errors, compile history, request stats @local', () => {
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
      // A one-time code in the query and a token in the fragment must never reach the log.
      await tab.goto(`${urlOf(host)}/?code=123456&e=${encodeURIComponent(LEAKED_EMAIL)}#token=${STAMP}`);
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
      expect(err.url).not.toMatch(/[?#]/);
      expect(text).not.toContain('123456');
      expect(text).not.toContain(`token=${STAMP}`);
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
    // An unknown route (and a 429) is not counted — only matched routes are.
    expect((await hostRequest(host, '/__drobek/v1/hello/nope')).status).toBe(404);
    // A mutation without the SDK header → 403 (csrf_rejected), a 4xx of hello.
    expect((await hostRequest(host, '/__drobek/v1/hello/wave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(403);
    // A missing file → 404, its path (never its query) listed under failing_paths.
    expect((await hostRequest(host, '/favicon.ico?v=secret')).status).toBe(404);

    const today = new Date().toISOString().slice(0, 10);
    type Paths = { path: string; count: number }[];
    type Day = {
      day: string;
      requests: number;
      count_5xx: number;
      count_404: number;
      modules: Record<string, Record<string, number>>;
      failing_paths: { '4xx': Paths; '5xx': Paths };
    };
    let day: Day | undefined;
    await expect
      .poll(
        async () => {
          const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'requests' });
          expect(r.isError, JSON.stringify(r.json)).toBe(false);
          expect(r.json.untrusted).toBe(true);
          day = (r.json.entries as Day[]).find((d) => d.day === today);
          return (
            (day?.modules.hello?.['4xx'] ?? 0) >= 1 &&
            (day?.modules.hello?.['2xx'] ?? 0) >= 1 &&
            (day?.failing_paths['4xx'].some((p) => p.path === '/favicon.ico') ?? false)
          );
        },
        { timeout: 5_000, intervals: [250] }
      )
      .toBe(true);
    expect(day!.requests).toBeGreaterThanOrEqual(5);
    expect(day!.count_404).toBeGreaterThanOrEqual(1);
    const failing4xx = day!.failing_paths['4xx'].map((p) => p.path);
    expect(failing4xx).toEqual(expect.arrayContaining(['/favicon.ico', '/__drobek/v1/hello/wave', '/__drobek/v1/hello/nope']));
    expect(failing4xx.some((p) => p.includes('?'))).toBe(false);
    expect(Array.isArray(day!.failing_paths['5xx'])).toBe(true);
    expect(Object.keys(day!.modules.hello).sort()).toEqual(['2xx', '3xx', '4xx', '5xx']);
    expect(typeof day!.count_5xx).toBe('number');
    // Not an active module → never a row.
    expect(day!.modules._beacon).toBeUndefined();
  });

  test('requests: a flush never lowers the stored day (counters that restarted after a Redis flush)', async () => {
    skipUnlessLocal();
    const today = new Date().toISOString().slice(0, 10);
    // Postgres holds more than Redis — what a Redis restart leaves behind.
    const stored = await withDb(async (c) => {
      const res = await c.query(
        `UPDATE app_daily_stats
            SET request_count = request_count + 100000,
                path_404_counts = path_404_counts || '{"/before-restart": 40}'::jsonb
          WHERE app_id = $1 AND day = $2
          RETURNING request_count`,
        [app.app_id, today]
      );
      return Number(res.rows[0]?.request_count ?? 0);
    });
    expect(stored).toBeGreaterThan(100_000);
    expect((await hostRequest(host, '/')).status).toBe(200);

    const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'requests' });
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    const day = (r.json.entries as { day: string; requests: number; count_404: number }[]).find((d) => d.day === today);
    expect(day?.requests).toBeGreaterThanOrEqual(stored);
    expect(day?.count_404).toBeGreaterThanOrEqual(40);

    const row = await withDb(
      async (c) =>
        (await c.query(`SELECT request_count, path_404_counts FROM app_daily_stats WHERE app_id = $1 AND day = $2`, [app.app_id, today]))
          .rows[0] as { request_count: number; path_404_counts: Record<string, number> }
    );
    expect(row.request_count).toBeGreaterThanOrEqual(stored);
    expect(row.path_404_counts['/before-restart']).toBe(40);
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

  test('beacon: a client that sends the query string and fragment has them stripped server-side', async () => {
    skipUnlessLocal();
    const marker = `raw-client-${STAMP}`;
    const posted = await hostRequest(host, '/__drobek/v1/_beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'error', message: marker, url: `${urlOf(host)}/checkout?code=654321#otp=${STAMP}`, ts: Date.now() }] }),
    });
    expect(posted.status).toBeLessThan(300);
    let entry: RuntimeEntry | undefined;
    await expect
      .poll(
        async () => {
          const r = await callTool(mcp.client, 'get_logs', { app_id: app.app_id, kind: 'runtime' });
          entry = (r.json.entries as RuntimeEntry[]).find((e) => e.message.includes(marker));
          return entry !== undefined;
        },
        { timeout: 5_000, intervals: [250] }
      )
      .toBe(true);
    expect(entry!.url).toBe(`${urlOf(host)}/checkout`);
    expect(entry!.url).not.toContain('654321');
  });

  test('render signal: page loads and browser errors of the newest version, a failed image and a CSP block; "beacon": false turns it off', async ({ browser }) => {
    skipUnlessLocal();
    const demo = (await callTool(mcp.client, 'create_app', { name: 'Render demo', template: 'react-ts' })).json as unknown as Created;
    const rhost = previewHost(demo.slug);
    const w = await callTool(mcp.client, 'write_files', {
      app_id: demo.app_id,
      files: [{ path: 'src/main.tsx', content: RENDER_MAIN }],
      reasoning: 'A page with a missing image and a blocked fetch',
    });
    expect(w.isError, JSON.stringify(w.json)).toBe(false);
    expect((w.json.compile as { ok: boolean }).ok, JSON.stringify(w.json.compile)).toBe(true);

    const render = async (): Promise<Render> => {
      const r = await callTool(mcp.client, 'get_app', { app_id: demo.app_id });
      expect(r.isError, JSON.stringify(r.json)).toBe(false);
      return r.json.render as Render;
    };
    // Nobody opened version 2 yet; a plain HTTP request runs no script and counts nothing.
    const index = await hostRequest(rhost, '/');
    expect(index.status).toBe(200);
    expect(index.headers['server-timing']).toBe('drobek-version;desc="2"');
    expect(await render()).toEqual({ version: 2, beacon: true, page_loads: 0, errors: 0 });
    const before = await callTool(mcp.client, 'get_logs', { app_id: demo.app_id, kind: 'runtime' });
    expect(before.json.render).toEqual({ version: 2, beacon: true, page_loads: 0, errors: 0 });
    expect(String(before.json.note)).toContain('No page of version 2 has loaded in a browser yet');

    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.goto(`${urlOf(rhost)}/`);
      await expect(tab.getByRole('heading', { name: 'Render demo ready' })).toBeVisible();
      let signal: Render | undefined;
      await expect
        .poll(
          async () => {
            signal = await render();
            return signal.page_loads >= 1 && signal.errors >= 2;
          },
          { timeout: 5_000, intervals: [250] }
        )
        .toBe(true);
      expect(signal).toMatchObject({ version: 2, beacon: true });
    } finally {
      await ctx.close();
    }

    const logs = await callTool(mcp.client, 'get_logs', { app_id: demo.app_id, kind: 'runtime' });
    expect(logs.isError, JSON.stringify(logs.json)).toBe(false);
    expect(logs.structured).toBe(false);
    const entries = logs.json.entries as RuntimeEntry[];
    const image = entries.find((e) => e.type === 'resource');
    expect(image, JSON.stringify(entries)).toBeTruthy();
    expect(image!.message).toContain('Failed to load image');
    expect(image!.message).toContain('/missing-logo.png');
    expect(image!.version).toBe(2);
    const blocked = entries.find((e) => e.type === 'csp');
    expect(blocked, JSON.stringify(entries)).toBeTruthy();
    expect(blocked!.message).toContain('Content-Security-Policy blocked https://api.example.com');
    expect(blocked!.message).toContain('(connect-src)');
    expect(blocked!.version).toBe(2);
    expect(logs.text).not.toContain('v=secret');
    expect(logs.text).not.toContain('token=abc');
    expect(logs.text).toMatch(/<untrusted-app-logs [^>]*latest_version="2" beacon="on" page_loads="[1-9]\d*" page_errors="([2-9]|\d{2,})"/);
    expect(String(logs.json.note)).toContain('Version 2:');

    // "beacon": false: the compiler adds no beacon and drobek counts nothing for the version.
    const cfg = await callTool(mcp.client, 'read_file', { app_id: demo.app_id, path: 'drobek.json' });
    expect(cfg.isError, JSON.stringify(cfg.json)).toBe(false);
    const config = { ...(JSON.parse(cfg.json.content as string) as Record<string, unknown>), beacon: false };
    const off = await callTool(mcp.client, 'write_files', {
      app_id: demo.app_id,
      files: [{ path: 'drobek.json', content: `${JSON.stringify(config, null, 2)}\n` }],
      reasoning: 'Turn the browser error reports off',
    });
    expect(off.isError, JSON.stringify(off.json)).toBe(false);
    expect((off.json.compile as { ok: boolean }).ok, JSON.stringify(off.json.compile)).toBe(true);
    const mainJs = await hostRequest(rhost, '/main.js');
    expect(mainJs.status).toBe(200);
    expect(mainJs.body).not.toContain('/__drobek/beacon.js');
    expect((await hostRequest(rhost, '/')).headers['server-timing']).toBe('drobek-version;desc="3"');
    expect(await render()).toEqual({ version: 3, beacon: false, page_loads: 0, errors: 0 });
    const offLogs = await callTool(mcp.client, 'get_logs', { app_id: demo.app_id, kind: 'runtime' });
    expect(offLogs.text).toMatch(/<untrusted-app-logs [^>]*latest_version="3" beacon="off" nonce=/);
    expect(String(offLogs.json.note)).toContain('Version 3 has "beacon": false in drobek.json');
  });
});
