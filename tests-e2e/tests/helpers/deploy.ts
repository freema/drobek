import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { BASE_URL_MCP, BASE_URL_WEB } from '../../playwright.config';
import { loginViaEmail, uniqueEmail } from './auth';

/**
 * Shared deploy-pipeline harness (U6/U7 e2e): full login + OAuth consent +
 * connected MCP client, plus deploy_init → PUT → deploy_commit → poll helpers.
 * Not a spec file — Playwright's testMatch never collects it.
 */

const REDIRECT_URI = 'http://127.0.0.1:9988/callback';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: { client_name: 'drobek e2e serving client', redirect_uris: [REDIRECT_URI] },
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
    state: 'serving-state',
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
  return body.access_token as string;
}

export interface DeployClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

/** Full login + consent(deploy:write) + token + connected MCP client. */
export async function deployClient(
  page: Page,
  request: APIRequestContext
): Promise<DeployClient> {
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  await loginViaEmail(page, request, uniqueEmail('serve'));
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
  const client = new Client({ name: 'drobek-e2e-serving', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

export interface ToolCall {
  isError: boolean;
  json: Record<string, unknown>;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCall> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return {
    isError: Boolean(res.isError),
    json: JSON.parse(text) as Record<string, unknown>,
  };
}

export interface FileSpec {
  path: string;
  content: Buffer;
  contentType: string;
}

export function file(path: string, body: string, contentType: string): FileSpec {
  return { path, content: Buffer.from(body, 'utf8'), contentType };
}

export function indexHtml(tag: string): FileSpec {
  return file(
    'index.html',
    `<!doctype html><html><body><h1>drobek ${tag}</h1></body></html>`,
    'text/html'
  );
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
  spec: FileSpec
): Promise<void> {
  const res = await request.put(putUrl, {
    data: spec.content,
    headers: { 'content-type': spec.contentType },
  });
  expect(res.status(), `PUT ${spec.path}`).toBe(200);
}

export interface DeployResult {
  deployId: string;
  /** Workspace slug the app landed in (from deploy_init). */
  workspaceSlug: string;
  /** App slug (from deploy_init). */
  appSlug: string;
  /** Full serving URL `/:ws/app/:slug` (from deploy_init). */
  url: string;
}

/** deploy_init → upload missing files → deploy_commit → the app coordinates. */
export async function initUploadCommit(
  client: Client,
  request: APIRequestContext,
  opts: { name?: string; slug?: string; files: FileSpec[] }
): Promise<DeployResult> {
  const init = await callTool(client, 'deploy_init', {
    name: opts.name,
    slug: opts.slug,
    manifest: manifestOf(opts.files),
  });
  expect(init.isError, `deploy_init: ${JSON.stringify(init.json)}`).toBe(false);
  const deployId = init.json.deployId as string;
  const app = init.json.app as { workspace: string; slug: string; url: string };
  const uploads = init.json.uploads as { path: string; putUrl: string }[];

  const byPath = new Map(opts.files.map((f) => [f.path, f]));
  for (const up of uploads) {
    const f = byPath.get(up.path);
    if (f) await putUpload(request, up.putUrl, f);
  }

  const commit = await callTool(client, 'deploy_commit', { deployId });
  expect(commit.isError, `deploy_commit: ${JSON.stringify(commit.json)}`).toBe(false);
  return {
    deployId,
    workspaceSlug: app.workspace,
    appSlug: app.slug,
    url: app.url,
  };
}

export async function waitForState(
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
