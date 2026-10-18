import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE_URL_WEB } from '../playwright.config';
import { hostRequest, previewHost, urlOf } from './helpers/apps-host';
import { skipUnlessLocal } from './helpers/auth';
import { FULL_SCOPE, callTool, mcpClient, type McpClient } from './helpers/mcp';

/**
 * Porting a Lovable-shaped Vite + React export to drobek — the procedure of
 * the `port-app` skill, done here by the test the way an agent does it:
 *
 *  - `tests-eval/fixtures/lovable-ported/` is the port of
 *    `tests-eval/fixtures/lovable-export/` (React 18 + shadcn/ui with the `@/`
 *    alias, react-router-dom, react-query, sonner, a Supabase guestbook
 *    table): the components are unchanged, `drobek.json` pins every package
 *    on esm.sh with `?deps=react@18.3.1` and resolves `@/` through `paths`,
 *    index.html loads Tailwind's browser build with the export's theme, the
 *    Supabase table is a `messages` collection of the data module;
 *  - create_app (react-ts) → write_files in two parts (everything but the
 *    entry, then `src/main.tsx` + `src/App.tsx`), the logo from `public/`
 *    through create_asset_upload, the collection with configure_module and
 *    the owner's confirmation of its public `create`;
 *  - the version compiles without a warning and the preview serves it;
 *  - in a browser the page renders with the export's theme colors (Tailwind
 *    passed the app CSP), a visitor signs the guestbook, a deep link renders
 *    the catch-all route, and no CSP violation or page error happens.
 */

interface Created {
  app_id: string;
  slug: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORTED = join(repoRoot, 'tests-eval', 'fixtures', 'lovable-ported');
const LOGO = readFileSync(join(repoRoot, 'tests-eval', 'fixtures', 'lovable-export', 'public', 'logo.png'));
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(relative(PORTED, p).split('\\').join('/'));
  }
  return out.sort();
}

const files = walk(PORTED);
const ENTRY = ['src/main.tsx', 'src/App.tsx'];
const contentOf = (path: string) => ({ path, content: readFileSync(join(PORTED, path), 'utf8') });

/** The upload URL on THIS target's dashboard origin (the tool builds it from PUBLIC_APP_URL). */
const onDashboard = (url: string): string => `${BASE_URL_WEB}${new URL(url).pathname}`;

/** The export's theme: --background 40 33% 98% and --primary 173 80% 26%, through `hsl(var(--…))`. */
const BODY_BG = 'rgb(252, 250, 248)';
const PRIMARY = 'rgb(13, 119, 107)';

test.describe.configure({ mode: 'serial' });

test.describe('port a Lovable export — shadcn/ui with the @/ alias, esm.sh with one React, Tailwind in the page @local', () => {
  let mcp: McpClient;
  let owner: BrowserContext;
  let app: Created & { host: string };

  test.afterAll(async () => {
    await mcp?.client.close();
    await owner?.close();
  });

  test('the fixture is a text-only port of at most 20 files with a drobek.json paths alias', () => {
    expect(files.every((f) => ['.json', '.html', '.svg', '.txt', '.tsx', '.ts', '.css'].includes(extname(f)))).toBe(true);
    expect(files.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(contentOf('drobek.json').content).paths).toEqual({ '@/*': ['src/*'] });
    for (const f of ENTRY) expect(files).toContain(f);
  });

  test("skill_info('port-app') is listed and carries the procedure", async ({ page, request }) => {
    skipUnlessLocal();
    mcp = await mcpClient(page, request, { tag: 'port-app', scope: FULL_SCOPE });
    owner = await page.context().browser()!.newContext({ storageState: await page.context().storageState() });
    const list = await callTool(mcp.client, 'skill_info', {});
    expect(list.isError, JSON.stringify(list.json)).toBe(false);
    expect(JSON.stringify(list.json)).toContain('port-app');
    const info = await callTool(mcp.client, 'skill_info', { name: 'port-app' });
    expect(info.isError, JSON.stringify(info.json)).toBe(false);
    expect(info.json).toMatchObject({ name: 'port-app', kind: 'general' });
    expect(String(info.json.content)).toContain('"paths": { "@/*": ["src/*"] }');
  });

  test('create_app → write_files in two parts → asset upload → data collection → compiles without a warning and serves', async ({ request }) => {
    skipUnlessLocal();
    const created = (await callTool(mcp.client, 'create_app', { name: `Ported guestbook ${STAMP}`, template: 'react-ts' })).json as unknown as Created;
    app = { ...created, host: previewHost(created.slug) };

    const first = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: files.filter((f) => !ENTRY.includes(f)).map(contentOf),
      reasoning: 'Port the Lovable export: config, page, styles, components and pages',
    });
    expect(first.isError, JSON.stringify(first.json)).toBe(false);
    expect((first.json.compile as { ok: boolean }).ok, JSON.stringify(first.json.compile)).toBe(true);

    const grant = await callTool(mcp.client, 'create_asset_upload', { app_id: app.app_id, path: 'logo.png', size: LOGO.length });
    expect(grant.isError, JSON.stringify(grant.json)).toBe(false);
    const put = await request.put(onDashboard(String(grant.json.upload_url)), {
      data: LOGO,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(put.status(), await put.text()).toBe(201);

    const configured = await callTool(mcp.client, 'configure_module', {
      app_id: app.app_id,
      module: 'data',
      config: {
        collections: {
          messages: {
            schema: {
              type: 'object',
              required: ['name', 'message'],
              properties: { name: { type: 'string', maxLength: 80 }, message: { type: 'string', maxLength: 500 } },
            },
            rules: { read: 'public', create: 'public', update: 'admin', delete: 'admin' },
          },
        },
      },
    });
    expect(configured.isError, JSON.stringify(configured.json)).toBe(false);
    if (configured.json.applied === false) {
      const ok = await owner.request.post(`${BASE_URL_WEB}/api/apps/${app.app_id}/modules/data/confirm`, { headers: { Origin: BASE_URL_WEB }, maxRedirects: 0 });
      expect(ok.status(), await ok.text()).toBe(200);
    }

    const second = await callTool(mcp.client, 'write_files', {
      app_id: app.app_id,
      files: [...ENTRY.map(contentOf), { path: 'src/styles.css', delete: true }],
      reasoning: 'Port the Lovable export: the entry and the router shell',
    });
    expect(second.isError, JSON.stringify(second.json)).toBe(false);
    const compile = second.json.compile as { ok: boolean; warnings: { code: string }[] };
    expect(compile.ok, JSON.stringify(compile)).toBe(true);
    expect(compile.warnings, JSON.stringify(compile.warnings)).toEqual([]);

    const doc = await hostRequest(app.host, '/');
    expect(doc.status).toBe(200);
    expect(doc.body).toContain('https://esm.sh/@tailwindcss/browser@4.1.11');
    expect(doc.headers['content-security-policy']).toContain('script-src');
    const js = await hostRequest(app.host, '/main.js');
    expect(js.status).toBe(200);
    for (const m of js.body.matchAll(/(?:from|import)\s*"(https?:\/\/[^"]+)"/g)) expect(m[1]).toMatch(/^https:\/\/esm\.sh\//);
    expect(js.body).toContain('https://esm.sh/lucide-react@0.462.0?deps=react@18.3.1');
    expect((await hostRequest(app.host, '/logo.png')).status).toBe(200);
    expect((await hostRequest(app.host, '/favicon.svg')).status).toBe(200);
    expect((await hostRequest(app.host, '/drobek.json')).body).not.toContain('"paths"');
  });

  test('in a browser: the export\'s theme, signing the guestbook, a deep link — and no CSP violation', async ({ browser }) => {
    skipUnlessLocal();
    const ctx = await browser.newContext();
    try {
      const tab = await ctx.newPage();
      await tab.addInitScript(() => {
        const w = window as unknown as { __violations: string[] };
        w.__violations = [];
        document.addEventListener('securitypolicyviolation', (e) => w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`));
      });
      const errors: string[] = [];
      const cspConsole: string[] = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      tab.on('console', (m) => {
        if (/Content Security Policy/i.test(m.text())) cspConsole.push(m.text());
      });

      await tab.goto(urlOf(app.host), { waitUntil: 'networkidle' });
      await expect(tab.getByRole('heading', { name: 'Guestbook', exact: true })).toBeVisible();
      await expect(tab.getByText('No messages yet. Be the first!')).toBeVisible();
      const sign = tab.getByRole('button', { name: 'Sign' });
      await expect.poll(() => sign.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe(PRIMARY);
      expect(await tab.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BODY_BG);
      expect(await tab.locator('svg.lucide').count()).toBeGreaterThanOrEqual(2);
      expect(await tab.evaluate(() => (document.querySelector('img[src="/logo.png"]') as HTMLImageElement | null)?.naturalWidth)).toBe(40);

      const note = `Hello from the port ${STAMP}`;
      await tab.getByLabel('Name').fill('Ada');
      await tab.getByLabel('Message').fill(note);
      await sign.click();
      await expect(tab.getByText(note)).toBeVisible();
      await expect(tab.getByText('Thanks for signing!')).toBeVisible();

      await tab.setViewportSize({ width: 390, height: 844 });
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await tab.goto(`${urlOf(app.host)}/no-such-page`, { waitUntil: 'networkidle' });
      await expect(tab.getByRole('heading', { name: '404' })).toBeVisible();
      await expect(tab.getByRole('link', { name: 'Return to Home' })).toBeVisible();

      expect(await tab.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
      expect(cspConsole).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
