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
 * Shared MCP harness: full login + OAuth consent (PKCE S256) + token exchange +
 * a connected Streamable-HTTP MCP client, plus a JSON tool-call helper.
 * Not a spec file — Playwright's testMatch never collects it.
 */

const REDIRECT_URI = 'http://127.0.0.1:9988/callback';

/** Every scope the AS issues — tools/list then carries all 10 tools. */
export const FULL_SCOPE =
  'mcp:whoami apps:read deploy:write data:read data:write';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: { client_name: 'drobek e2e MCP client', redirect_uris: [REDIRECT_URI] },
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
  opts: {
    clientId: string;
    challenge: string;
    resource: string;
    scope: string;
    workspaceLabel?: string;
  }
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: opts.scope,
    resource: opts.resource,
    state: 'e2e-state',
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();
  if (opts.workspaceLabel) {
    // Bind the token to a non-default workspace (label "<name> (<role>)").
    await page
      .getByTestId('workspace-select')
      .selectOption({ label: opts.workspaceLabel });
  }
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

export interface McpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** The signed-in user's email (the token subject). */
  email: string;
  /** The workspace slug the token is bound to (from whoami). */
  workspace: string;
}

/**
 * Full login (a fresh unique user, or `opts.email`) + consent(`scope`) + token +
 * connected MCP client. Leaves `page` signed in as that user. The token binds to
 * the user's personal workspace unless `workspaceLabel` picks another one on
 * the consent screen; the bound slug is returned as `workspace`. Pass
 * `signedIn: true` (with `email`) when `page` already holds that user's session.
 */
export async function mcpClient(
  page: Page,
  request: APIRequestContext,
  opts: {
    tag?: string;
    scope?: string;
    email?: string;
    signedIn?: boolean;
    workspaceLabel?: string;
  } = {}
): Promise<McpClient> {
  const scope = opts.scope ?? FULL_SCOPE;
  const email = opts.email ?? uniqueEmail(opts.tag ?? 'mcp');
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  if (!opts.signedIn) await loginViaEmail(page, request, email);
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, {
    clientId,
    challenge,
    resource,
    scope,
    workspaceLabel: opts.workspaceLabel,
  });
  const accessToken = await exchangeCode(request, { code, verifier, clientId });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const client = new Client({ name: 'drobek-e2e', version: '0.0.0' });
  await client.connect(transport);

  const who = await callTool(client, 'whoami', {});
  expect(who.isError, `whoami: ${JSON.stringify(who.json)}`).toBe(false);
  return {
    client,
    transport,
    email,
    workspace: who.json.workspace as string,
  };
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
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON error text (e.g. "Access denied: …") — keep it inspectable.
    json = { text };
  }
  return { isError: Boolean(res.isError), json };
}
