import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { BASE_URL_MCP, BASE_URL_WEB } from '../playwright.config';
import { loginViaEmail, skipUnlessLocal, uniqueEmail } from './helpers/auth';

/**
 * U6 acceptance (PHY-57 / PHY-70 / PHY-63 / PHY-100): drive the deploy pipeline
 * as an MCP client would — deploy_init (presigned PUTs for missing hashes only)
 * → out-of-band PUT → deploy_commit → worker (strict lint, content-hash store,
 * immutable version, activate) → deploy_status streams to `ready` → rollback.
 * Plus the negatives: chromium/puppeteer app rejected, oversized rejected, dedup
 * omits an unchanged file's putUrl. Requires the local compose stack + worker.
 */

const REDIRECT_URI = 'http://127.0.0.1:9988/callback';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: { client_name: 'drobek e2e deploy client', redirect_uris: [REDIRECT_URI] },
  });
  expect(res.status(), 'DCR register').toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function mcpResource(request: APIRequestContext): Promise<string> {
  const res = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(res.status()).toBe(200);
  return ((await res.json()) as { resource: string }).resource;
}

async function consentAndGetCode(
  page: Page,
  opts: { clientId: string; challenge: string; resource: string; scope: string }
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: opts.scope,
    resource: opts.resource,
    state: 'deploy-state',
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();
  const captured = new Promise<string>((resolve) => {
    void page.route('http://127.0.0.1:9988/**', (route) => {
      const url = route.request().url();
      void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
      resolve(url);
    });
  });
  await page.getByTestId('consent-approve').click();
  const capturedUrl = await captured;
  await page.unroute('http://127.0.0.1:9988/**');
  const code = new URL(capturedUrl).searchParams.get('code');
  expect(code, 'authorization code present').toBeTruthy();
  return code as string;
}

async function exchangeCode(
  request: APIRequestContext,
  opts: { code: string; verifier: string; clientId: string }
): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.verifier,
      client_id: opts.clientId,
    },
  });
  expect(res.status(), 'token exchange').toBe(200);
  const body = (await res.json()) as { access_token?: string; scope?: string };
  expect(body.access_token, 'access token issued').toBeTruthy();
  expect(body.scope, 'deploy:write granted').toContain('deploy:write');
  return body.access_token as string;
}

/** Full login + consent(deploy:write) + token + connected MCP client. */
async function deployClient(
  page: Page,
  request: APIRequestContext
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  await loginViaEmail(page, request, uniqueEmail('deploy'));
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, {
    clientId,
    challenge,
    resource,
    scope: 'mcp:whoami apps:read deploy:write',
  });
  const accessToken = await exchangeCode(request, { code, verifier, clientId });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const client = new Client({ name: 'drobek-e2e-deploy', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

interface ToolCall {
  isError: boolean;
  json: Record<string, unknown>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCall> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { isError: Boolean(res.isError), json: JSON.parse(text) as Record<string, unknown> };
}

interface FileSpec {
  path: string;
  content: Buffer;
  contentType: string;
}

function file(path: string, body: string, contentType: string): FileSpec {
  return { path, content: Buffer.from(body, 'utf8'), contentType };
}

function manifestOf(files: FileSpec[]) {
  return files.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.content),
    bytes: f.content.byteLength,
  }));
}

async function putUpload(
  request: APIRequestContext,
  putUrl: string,
  file: FileSpec
): Promise<void> {
  const res = await request.put(putUrl, {
    data: file.content,
    headers: { 'content-type': file.contentType },
  });
  expect(res.status(), `PUT ${file.path}`).toBe(200);
}

/** deploy_init → upload the returned putUrls → deploy_commit → return deployId. */
async function initUploadCommit(
  client: Client,
  request: APIRequestContext,
  opts: { name?: string; slug?: string; files: FileSpec[] }
): Promise<{ deployId: string; uploads: { path: string; putUrl: string }[] }> {
  const init = await callTool(client, 'deploy_init', {
    name: opts.name,
    slug: opts.slug,
    manifest: manifestOf(opts.files),
  });
  expect(init.isError, `deploy_init: ${JSON.stringify(init.json)}`).toBe(false);
  const deployId = init.json.deployId as string;
  const uploads = init.json.uploads as { path: string; putUrl: string }[];

  const byPath = new Map(opts.files.map((f) => [f.path, f]));
  for (const up of uploads) {
    const f = byPath.get(up.path);
    if (f) await putUpload(request, up.putUrl, f);
  }

  const commit = await callTool(client, 'deploy_commit', { deployId });
  expect(commit.isError, `deploy_commit: ${JSON.stringify(commit.json)}`).toBe(false);
  return { deployId, uploads };
}

async function waitForState(
  client: Client,
  deployId: string,
  target: string,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const status = await callTool(client, 'deploy_status', { deployId });
    last = status.json;
    if (last.state === target) return last;
    if (last.state === 'failed' && target !== 'failed') {
      throw new Error(`deploy failed unexpectedly: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${target}; last=${JSON.stringify(last)}`);
}

function indexHtml(tag: string): FileSpec {
  return file(
    'index.html',
    `<!doctype html><html><body><h1>drobek ${tag}</h1></body></html>`,
    'text/html'
  );
}

test('deploy happy path → ready → active, then dedup on re-deploy + SSE stream @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('deploy_init');
    expect(tools).toContain('deploy_commit');
    expect(tools).toContain('deploy_status');
    expect(tools).toContain('rollback');

    const salt = randomBytes(6).toString('hex');
    const index = indexHtml(`v1 ${salt}`);
    const appJs = file('app.js', `console.log("v1 ${salt}");`, 'application/javascript');

    const { deployId, uploads } = await initUploadCommit(client, request, {
      name: `E2E Deploy ${salt}`,
      files: [index, appJs],
    });
    // Both files are new content → both get an upload URL.
    expect(uploads.map((u) => u.path).sort()).toEqual(['app.js', 'index.html']);

    const ready = await waitForState(client, deployId, 'ready');
    expect(ready.active).toBe(true);
    expect(ready.url).toContain('/a/');
    const slug = ready.appSlug as string;

    // SSE: after ready the initial event is terminal — one event, stream closes.
    const sse = await page.request.get(`/api/deploys/${deployId}/events`);
    expect(sse.status()).toBe(200);
    expect(sse.headers()['content-type']).toContain('text/event-stream');
    const body = await sse.text();
    expect(body).toContain('"state":"ready"');

    // Re-deploy the SAME index.html (unchanged) + a CHANGED app.js → dedup omits
    // the unchanged file's putUrl.
    const appJs2 = file('app.js', `console.log("v2 ${salt}");`, 'application/javascript');
    const init2 = await callTool(client, 'deploy_init', {
      slug,
      manifest: manifestOf([index, appJs2]),
    });
    expect(init2.isError).toBe(false);
    const uploads2 = init2.json.uploads as { path: string }[];
    expect(uploads2.map((u) => u.path)).toEqual(['app.js']); // index.html deduped
  } finally {
    await transport.close();
  }
});

test('a chromium/puppeteer reference is rejected by the lint gate (deploy → failed) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const index = indexHtml(`bot ${salt}`);
    const bot = file(
      'bot.js',
      `import puppeteer from 'puppeteer'; // ${salt}\nawait puppeteer.launch();`,
      'application/javascript'
    );

    const { deployId } = await initUploadCommit(client, request, {
      name: `E2E Bot ${salt}`,
      files: [index, bot],
    });

    const failed = await waitForState(client, deployId, 'failed');
    expect(failed.state).toBe('failed');
    expect(failed.active).toBe(false); // pointer never flipped to a blocked deploy
    expect(String(failed.error)).toMatch(/puppeteer|headless|lint/i);
  } finally {
    await transport.close();
  }
});

test('an oversized file is rejected at deploy_init (quota) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const index = manifestOf([indexHtml(`big ${salt}`)])[0];
    // Declare a file far over DEPLOY_MAX_FILE_BYTES (dev default 10 MiB). Rejected
    // before any upload — no bytes are ever sent.
    const oversized = {
      path: 'huge.bin',
      sha256: sha256Hex(Buffer.from(`huge-${salt}`)),
      bytes: 999_999_999,
    };
    const init = await callTool(client, 'deploy_init', {
      name: `E2E Oversized ${salt}`,
      manifest: [index, oversized],
    });
    expect(init.isError).toBe(true);
    expect(init.json.error).toBe('file_too_large');
  } finally {
    await transport.close();
  }
});

test('rollback restores the prior ready deploy @local', async ({ page, request }) => {
  skipUnlessLocal();
  const { client, transport } = await deployClient(page, request);
  try {
    const salt = randomBytes(6).toString('hex');
    const slug = `rollback-${salt}`;
    const index = indexHtml(`rb ${salt}`);

    // v1
    const v1 = await initUploadCommit(client, request, {
      slug,
      files: [index, file('app.js', `// v1 ${salt}`, 'application/javascript')],
    });
    await waitForState(client, v1.deployId, 'ready');

    // v2 (becomes active)
    const v2 = await initUploadCommit(client, request, {
      slug,
      files: [index, file('app.js', `// v2 ${salt}`, 'application/javascript')],
    });
    const v2ready = await waitForState(client, v2.deployId, 'ready');
    expect(v2ready.active).toBe(true);

    // rollback → previous ready deploy (v1)
    const rb = await callTool(client, 'rollback', { slug });
    expect(rb.isError, JSON.stringify(rb.json)).toBe(false);
    expect(rb.json.restoredDeployId).toBe(v1.deployId);

    const v1status = await callTool(client, 'deploy_status', { deployId: v1.deployId });
    expect(v1status.json.active).toBe(true);
    const v2status = await callTool(client, 'deploy_status', { deployId: v2.deployId });
    expect(v2status.json.active).toBe(false);
  } finally {
    await transport.close();
  }
});
