import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL_MCP, BASE_URL_WEB, TEST_ENV } from '../playwright.config';
import { DASHBOARD_ORIGIN, getAppUrl, type Raw } from './helpers/apps-host';
import { loginViaEmail, resetDcrIpRateLimit, skipUnlessLocal, uniqueEmail } from './helpers/auth';
import { callTool, connectBearer } from './helpers/mcp';
import { withDb } from './helpers/seed';

/**
 * M0-08 (NSO-289): the agent loop, end to end, the way a real MCP client
 * (Claude Code, Cursor, …) drives it.
 *
 * 1. `@local` — the official SDK client with an OAuthClientProvider: 401 →
 *    RFC 9728/8414 discovery → Dynamic Client Registration → PKCE S256
 *    authorize (the consent screen driven by Playwright) → token → MCP, then
 *    list_apps → create_app → write_files (compile error → fix) → GET preview
 *    on the app host → publish → GET production host → restore_version →
 *    get_app. Must finish in < 90 s (asserted).
 * 2. `@smoke` — the same tool loop minus OAuth, safe against production
 *    (M0-09): a `drk_` API key from SMOKE_API_KEY (read from the environment
 *    only, never logged), public HTTP + MCP only against a non-local target —
 *    no database, Redis or Mailpit. Locally (TEST_ENV=local, no key) the key
 *    is minted straight into the local DB for a throwaway user.
 *    Cleanup (NSO-316) — MCP has no delete tool and gets none (no destructive
 *    MCP tool), so the app never outlives the run where it can be deleted:
 *    (a) TEST_ENV=local: a fresh `smoke-<random>` app, deleted at the end —
 *        also when the test fails (try/finally) — through the dashboard
 *        delete action (NSO-288) as the smoke user, signed in by e-mail OTP
 *        via Mailpit;
 *    (b) any other target (production): the smoke has only the API key, so
 *        it uses ONE stable slug per key, `smoke-<12 hex of sha256(key)>`,
 *        found via list_apps → get_app and re-used (a new version, published)
 *        instead of creating an app per run — production holds exactly one
 *        smoke app per smoke identity. It holds only a static marker page.
 */

const LOOP_BUDGET_MS = 90_000;
/** Loopback redirect_uri; the browser's redirect to it is intercepted. */
const REDIRECT_URI = 'http://127.0.0.1:9966/callback';

const TEMPLATE_FILES = ['drobek.json', 'index.html', 'src/main.tsx', 'src/styles.css'];

function tsx(marker: string, broken = false): string {
  return [
    "import { createRoot } from 'react-dom/client';",
    "import './styles.css';",
    '',
    'function App() {',
    `  return <main><h1 id="marker">${marker}</h1></main>;`,
    // Line 6: a syntax error (esbuild reports 1-based lines).
    broken ? '  const = 1;' : '',
    '}',
    '',
    "createRoot(document.getElementById('root')!).render(<App />);",
    '',
  ].join('\n');
}

/** An in-memory OAuth client, as an MCP host implements it (DCR, PKCE, tokens). */
class LoopOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private info: OAuthClientInformationMixed | undefined;
  private tokenSet: OAuthTokens | undefined;
  private verifier = '';
  readonly stateValue = randomBytes(12).toString('base64url');

  get redirectUrl(): string {
    return REDIRECT_URI;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'drobek e2e mcp-loop',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write publish',
    };
  }
  state(): string {
    return this.stateValue;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.info = info;
  }
  tokens(): OAuthTokens | undefined {
    return this.tokenSet;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.tokenSet = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

/** Open the authorization URL the SDK built, approve, return the redirect. */
async function approveConsent(page: Page, url: URL): Promise<URL> {
  await page.goto(url.toString());
  await expect(page.getByTestId('consent-approve')).toBeVisible();
  for (const scope of ['read', 'write', 'publish']) {
    await expect(page.getByTestId(`scope-${scope}`)).toBeChecked();
  }
  const redirect = new URL(REDIRECT_URI);
  const pattern = `${redirect.origin}/**`;
  const captured = new Promise<string>((resolve) => {
    void page.route(pattern, (route) => {
      resolve(route.request().url());
      void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
    });
  });
  await page.getByTestId('consent-approve').click();
  const back = new URL(await captured);
  await page.unroute(pattern);
  return back;
}

function newClient(): Client {
  return new Client({ name: 'drobek-e2e-mcp-loop', version: '0.0.0' });
}

/** GET an app URL, retried while a fresh host warms up (TLS issuance, DNS). */
async function getWhenUp(url: string, path = '/', expectStatus = 200): Promise<Raw> {
  let last: Raw | null = null;
  await expect
    .poll(
      async () => {
        try {
          last = await getAppUrl(url, path);
          return last.status;
        } catch (err) {
          return String(err);
        }
      },
      { timeout: 30_000, intervals: [250, 500, 1_000, 2_000] }
    )
    .toBe(expectStatus);
  return last as unknown as Raw;
}

test('mcp loop: DCR + PKCE consent → list → create → broken write → fix → preview → publish → prod → restore → get_app @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  test.setTimeout(LOOP_BUDGET_MS);
  const started = Date.now();
  const marker = `loop-fixed-${randomBytes(4).toString('hex')}`;
  const email = uniqueEmail('loop');

  // ── OAuth, exactly as an MCP host does it ────────────────────────────────
  await resetDcrIpRateLimit();
  const provider = new LoopOAuthProvider();
  const mcpUrl = new URL(`${BASE_URL_MCP}/mcp`);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  // No token → 401 → discovery → DCR → the SDK asks us to open the browser.
  await expect(newClient().connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const authUrl = provider.authorizationUrl as URL;
  expect(authUrl, 'the SDK produced an authorization URL').toBeTruthy();
  expect(`${authUrl.origin}${authUrl.pathname}`).toBe(`${BASE_URL_WEB.replace(/\/+$/, '')}/oauth/authorize`);
  const clientId = authUrl.searchParams.get('client_id');
  expect(clientId, 'registered via DCR').toBeTruthy();
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('code_challenge')).toBe(
    createHash('sha256').update(provider.codeVerifier()).digest('base64url')
  );
  expect(authUrl.searchParams.get('resource')).toBe(mcpUrl.toString());
  expect(authUrl.searchParams.get('scope')?.split(' ').sort()).toEqual(['publish', 'read', 'write']);

  // The user signs in and approves on the consent screen.
  await loginViaEmail(page, request, email);
  const back = await approveConsent(page, authUrl);
  expect(back.searchParams.get('state')).toBe(provider.stateValue);
  expect(back.searchParams.get('iss')).toBe(BASE_URL_WEB.replace(/\/+$/, ''));
  const code = back.searchParams.get('code');
  expect(code, 'authorization code').toBeTruthy();
  await first.finishAuth(code as string);
  expect(provider.tokens()?.access_token, 'access token').toBeTruthy();
  expect(provider.tokens()?.refresh_token, 'refresh token').toBeTruthy();
  expect(provider.tokens()?.scope?.split(' ').sort()).toEqual(['publish', 'read', 'write']);

  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  const client = newClient();
  await client.connect(transport);
  try {
    // ── list_apps: the token is bound to this user; nothing yet. ───────────
    const listed = await callTool(client, 'list_apps', {});
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.json.user).toEqual({ email });
    expect(listed.json.apps).toEqual([]);

    // ── create_app → v1 from the react-ts template, compiled. ─────────────
    const created = await callTool(client, 'create_app', { name: 'MCP Loop E2E' });
    expect(created.isError, created.text).toBe(false);
    expect(created.json).toMatchObject({ version: 1, template: 'react-ts', compile: { ok: true } });
    const appId = created.json.app_id as string;
    const slug = created.json.slug as string;
    const previewUrl = created.json.preview_url as string;
    expect(previewUrl).toContain(`${slug}--preview.`);

    // ── write_files with a syntax error → v2 stored, compile error with the line.
    const broken = await callTool(client, 'write_files', {
      app_id: appId,
      files: [{ path: 'src/main.tsx', content: tsx(marker, true) }],
      reasoning: 'Render the marker heading',
    });
    expect(broken.isError, broken.text).toBe(false);
    expect(broken.json).toMatchObject({ version: 2, compile: { ok: false }, preview_version: 1 });
    const errors = (broken.json.compile as { errors: { file: string; line: number }[] }).errors;
    expect(errors[0]).toMatchObject({ file: 'src/main.tsx', line: 6 });

    // ── The agent fixes it → v3 compiles. ─────────────────────────────────
    const fixed = await callTool(client, 'write_files', {
      app_id: appId,
      files: [{ path: 'src/main.tsx', content: tsx(marker) }],
      reasoning: 'Fix the syntax error on line 6',
    });
    expect(fixed.isError, fixed.text).toBe(false);
    expect(fixed.json).toMatchObject({ version: 3, compile: { ok: true }, preview_url: previewUrl });

    // ── GET preview on the app host: v3's built output. ───────────────────
    const previewHtml = await getAppUrl(previewUrl);
    expect(previewHtml.status).toBe(200);
    expect(previewHtml.body).toContain('<script type="module" src="/main.js"></script>');
    expect(previewHtml.headers['x-robots-tag']).toBe('noindex');
    const previewJs = await getAppUrl(previewUrl, '/main.js');
    expect(previewJs.status).toBe(200);
    expect(previewJs.body).toContain(marker);

    // Not published yet: the production host says so.
    const prodUrl = previewUrl.replace(`${slug}--preview.`, `${slug}.`);
    const unpublished = await getAppUrl(prodUrl);
    expect(unpublished.status).toBe(404);

    // ── publish → the production host serves v3. ──────────────────────────
    const published = await callTool(client, 'publish', { app_id: appId });
    expect(published.isError, published.text).toBe(false);
    expect(published.json).toMatchObject({ published_version: 3, previous_version: null, published_url: prodUrl });
    const prodHtml = await getAppUrl(prodUrl);
    expect(prodHtml.status).toBe(200);
    expect(prodHtml.body).toBe(previewHtml.body);
    expect(prodHtml.headers['x-robots-tag']).toBeUndefined();
    expect((await getAppUrl(prodUrl, '/main.js')).body).toContain(marker);

    // ── restore_version(1) → a new v4 with v1's content; production stays on v3.
    const restored = await callTool(client, 'restore_version', { app_id: appId, version: 1 });
    expect(restored.isError, restored.text).toBe(false);
    expect(restored.json).toMatchObject({ version: 4, restored_from: 1, compile: { ok: true } });
    expect((await getAppUrl(previewUrl, '/main.js')).body).not.toContain(marker);
    expect((await getAppUrl(prodUrl, '/main.js')).body).toContain(marker);

    // ── get_app: the whole history, the pointers, the template files back. ─
    const app = await callTool(client, 'get_app', { app_id: appId });
    expect(app.isError, app.text).toBe(false);
    expect(app.json).toMatchObject({
      app_id: appId,
      slug,
      latest_version: 4,
      published_version: 3,
      published_url: prodUrl,
      preview_url: previewUrl,
      compile_status: 'ok',
    });
    const versions = app.json.versions as { number: number; compile_status: string; actor_kind: string }[];
    expect(versions.map((v) => [v.number, v.compile_status])).toEqual([
      [4, 'ok'],
      [3, 'ok'],
      [2, 'error'],
      [1, 'ok'],
    ]);
    for (const v of versions) expect(v.actor_kind).toBe('agent');
    expect((app.json.files as { path: string }[]).map((f) => f.path).sort()).toEqual(TEMPLATE_FILES);
  } finally {
    await transport.close();
  }

  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: 'duration', description: `mcp-loop ${elapsed} ms` });
  console.log(`mcp-loop: ${elapsed} ms (budget ${LOOP_BUDGET_MS} ms)`);
  expect(elapsed).toBeLessThan(LOOP_BUDGET_MS);
});

/**
 * The smoke credential. Production (M0-09): SMOKE_API_KEY from the deploy
 * job's secrets. Local stack: a throwaway user + key written straight into the
 * local DB (withDb refuses unless TEST_ENV=local).
 */
async function smokeKey(): Promise<string | null> {
  const fromEnv = process.env.SMOKE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (TEST_ENV !== 'local') return null;
  const key = `drk_${randomBytes(24).toString('base64url')}`;
  const userId = `usr${randomBytes(12).toString('hex')}`;
  await withDb(async (c) => {
    await c.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, uniqueEmail('smoke')]);
    await c.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, scopes) VALUES ($1, $2, 'smoke', $3, 'read write publish')`,
      [`key${randomBytes(8).toString('hex')}`, userId, createHash('sha256').update(key).digest('hex')]
    );
  });
  return key;
}

/**
 * The ONE slug a non-local smoke identity uses, run after run:
 * `smoke-<12 hex>` of a domain-separated SHA-256 of the key. Derived from the
 * secret (not from the key id or e-mail, which the client does not know or
 * others could guess), so nobody can squat it; it is not the stored
 * `key_hash` either (different input), so the public slug reveals nothing
 * about that. A rotated key simply moves the smoke to a new slug — the old
 * app is then deleted by hand (runbook, docs/progress.md → Next → M0-09).
 */
function stableSmokeSlug(key: string): string {
  return `smoke-${createHash('sha256').update(`drobek-smoke-app:${key}`).digest('hex').slice(0, 12)}`;
}

/**
 * Local cleanup: the dashboard delete (NSO-288) as the smoke user — e-mail
 * OTP sign-in through Mailpit, Settings → type the slug → Delete. MCP has no
 * delete tool, by design (no destructive MCP tool).
 */
async function deleteViaDashboard(
  page: Page,
  request: APIRequestContext,
  app: { email: string; workspace: string; slug: string }
): Promise<void> {
  await loginViaEmail(page, request, app.email);
  await page.goto(`/workspaces/${app.workspace}/apps/${app.slug}/settings`);
  await page.getByTestId('delete-confirm-input').fill(app.slug);
  await page.getByTestId('delete-button').click();
  await page.waitForURL((url) => url.searchParams.get('deleted') === app.slug);
}

test('smoke loop: API key → list → create/reuse smoke-* → write → preview → publish → prod host → cleanup @smoke', async ({
  page,
  request,
}) => {
  test.setTimeout(LOOP_BUDGET_MS);
  const key = await smokeKey();
  const web = new URL(BASE_URL_WEB);
  if (!key) {
    // A local target without TEST_ENV=local simply has no credential; any
    // other target (production after a deploy) MUST be given one.
    test.skip(
      web.hostname === 'localhost' || web.hostname === '127.0.0.1',
      'no SMOKE_API_KEY (and not TEST_ENV=local)'
    );
    throw new Error('SMOKE_API_KEY is required for the @smoke MCP loop against a non-local target');
  }
  // Local stack → a fresh `smoke-<random>` app, deleted through the dashboard
  // at the end. Anywhere else (production) → the identity's one stable slug,
  // reused every run: nothing to delete, nothing accumulates.
  const mode: 'delete' | 'reuse' = TEST_ENV === 'local' ? 'delete' : 'reuse';

  const marker = `smoke-${randomBytes(4).toString('hex')}`;
  const { client, transport } = await connectBearer(key);
  /** Set as soon as a (local) app exists, so cleanup runs even on failure. */
  let toDelete: { email: string; workspace: string; slug: string } | null = null;
  let failed = false;
  try {
    const listed = await callTool(client, 'list_apps', {});
    expect(listed.isError, listed.text).toBe(false);
    const email = (listed.json.user as { email?: string }).email as string;
    expect(email).toBeTruthy();

    let appId: string;
    let previewUrl: string;
    let baseVersion: number;
    const stable = mode === 'reuse' ? stableSmokeSlug(key) : null;
    const existing = stable
      ? (listed.json.apps as { app_id: string; slug: string }[]).find((a) => a.slug === stable)
      : undefined;
    if (existing) {
      const got = await callTool(client, 'get_app', { app_id: existing.app_id });
      expect(got.isError, got.text).toBe(false);
      appId = existing.app_id;
      previewUrl = got.json.preview_url as string;
      baseVersion = got.json.latest_version as number;
    } else {
      // The slug is derived from the name: `smoke-<random>` locally (or a
      // free variant of it), the stable slug in production.
      const created = await callTool(client, 'create_app', { name: stable ?? marker });
      expect(created.isError, created.text).toBe(false);
      expect(created.json).toMatchObject({ version: 1, compile: { ok: true } });
      appId = created.json.app_id as string;
      const slug = created.json.slug as string;
      if (mode === 'delete') toDelete = { email, workspace: created.json.workspace as string, slug };
      expect(slug.startsWith('smoke-')).toBe(true);
      if (mode === 'reuse') {
        // A variant would mean a new app every run — exactly what reuse avoids.
        expect(slug, 'the stable smoke slug is free for this identity').toBe(stable);
      }
      previewUrl = created.json.preview_url as string;
      baseVersion = 1;
    }

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${marker}</title></head><body><p id="marker">${marker}</p></body></html>\n`;
    const written = await callTool(client, 'write_files', {
      app_id: appId,
      files: [{ path: 'index.html', content: html }],
      reasoning: 'drobek post-deploy smoke test',
    });
    expect(written.isError, written.text).toBe(false);
    expect(written.json).toMatchObject({ compile: { ok: true } });
    const version = written.json.version as number;
    expect(version).toBeGreaterThan(baseVersion);

    const preview = await getWhenUp(previewUrl);
    expect(preview.body).toContain(`<p id="marker">${marker}</p>`);
    expect(preview.headers['x-robots-tag']).toBe('noindex');

    const published = await callTool(client, 'publish', { app_id: appId });
    expect(published.isError, published.text).toBe(false);
    expect(published.json.published_version).toBe(version);
    const prod = await getWhenUp(published.json.published_url as string);
    expect(prod.body).toContain(`<p id="marker">${marker}</p>`);
    // NSO-342: only the dashboard (its app-list thumbnail) may frame the app.
    expect(prod.headers['content-security-policy']).toContain(`frame-ancestors ${DASHBOARD_ORIGIN};`);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    try {
      if (toDelete) {
        const app = toDelete;
        await deleteViaDashboard(page, request, app);
        const gone = await callTool(client, 'list_apps', {});
        expect((gone.json.apps as { slug: string }[]).map((a) => a.slug)).not.toContain(app.slug);
      }
    } catch (cleanupErr) {
      // Never mask the test's own failure with a cleanup failure.
      if (!failed) throw cleanupErr;
      console.error(`smoke cleanup failed: ${String(cleanupErr)}`);
    } finally {
      await transport.close();
    }
  }
});
