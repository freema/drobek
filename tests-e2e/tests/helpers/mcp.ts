import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { BASE_URL_MCP, BASE_URL_WEB } from '../../playwright.config';
import { loginViaEmail, resetDcrIpRateLimit, uniqueEmail } from './auth';

/**
 * Shared MCP harness: full login + OAuth consent (PKCE S256) + token exchange +
 * a connected Streamable-HTTP MCP client, plus a JSON tool-call helper.
 * Tokens are USER-bound (M0-04): the consent screen has no workspace choice,
 * only the read / write / publish checkboxes.
 * Not a spec file — Playwright's testMatch never collects it.
 */

/** The loopback redirect_uri the browser's cross-origin redirect is intercepted at. */
export const REDIRECT_URI = 'http://127.0.0.1:9988/callback';

/** Every scope the AS issues — tools/list then carries all 10 tools. */
export const FULL_SCOPE = 'read write publish';

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** DCR (after clearing the shared local per-IP registration bucket). */
export async function registerClient(request: APIRequestContext): Promise<string> {
  await resetDcrIpRateLimit();
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: { client_name: 'drobek e2e MCP client', redirect_uris: [REDIRECT_URI] },
  });
  expect(res.status(), 'DCR register').toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

export async function mcpResource(request: APIRequestContext): Promise<string> {
  const res = await request.get(
    `${BASE_URL_MCP}/.well-known/oauth-protected-resource`
  );
  expect(res.status()).toBe(200);
  return ((await res.json()) as { resource: string }).resource;
}

/**
 * Drive the consent screen (optionally unchecking some requested scopes) and
 * return the whole redirect URL (code, state, iss).
 */
export async function consentAndCapture(
  page: Page,
  opts: {
    clientId: string;
    challenge: string;
    resource: string;
    scope: string;
    uncheck?: string[];
  }
): Promise<URL> {
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
  for (const scope of opts.uncheck ?? []) {
    await page.getByTestId(`scope-${scope}`).uncheck();
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
  return new URL(capturedUrl);
}

async function consentAndGetCode(
  page: Page,
  opts: { clientId: string; challenge: string; resource: string; scope: string }
): Promise<string> {
  const url = await consentAndCapture(page, opts);
  const code = url.searchParams.get('code');
  expect(code, 'authorization code present').toBeTruthy();
  return code as string;
}

export interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

export async function exchangeCode(
  request: APIRequestContext,
  opts: { code: string; verifier: string; clientId: string }
): Promise<{ status: number; body: TokenBody }> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.verifier,
      client_id: opts.clientId,
    },
  });
  return { status: res.status(), body: (await res.json()) as TokenBody };
}

/** Connect the official SDK client with a Bearer (OAuth token or drk_ API key). */
export async function connectBearer(
  bearer: string
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }
  );
  const client = new Client({ name: 'drobek-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** A raw MCP initialize POST — for the auth negatives (no SDK). */
export async function rawInitialize(
  request: APIRequestContext,
  headers: Record<string, string>
) {
  return request.post(`${BASE_URL_MCP}/mcp`, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e-raw', version: '0' },
      },
    },
  });
}

export interface WhoamiWorkspace {
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  role: string;
}

export interface McpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** The signed-in user's email (the token subject). */
  email: string;
  /** The user's PERSONAL workspace slug (from whoami) — where specs seed apps. */
  workspace: string;
  /** Every workspace the user belongs to (from whoami). */
  workspaces: WhoamiWorkspace[];
}

/**
 * Full login (a fresh unique user, or `opts.email`) + consent(`scope`) + token +
 * connected MCP client. Leaves `page` signed in as that user. Pass
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
  } = {}
): Promise<McpClient> {
  const scope = opts.scope ?? FULL_SCOPE;
  const email = opts.email ?? uniqueEmail(opts.tag ?? 'mcp');
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  if (!opts.signedIn) await loginViaEmail(page, request, email);
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, { clientId, challenge, resource, scope });
  const tok = await exchangeCode(request, { code, verifier, clientId });
  expect(tok.status, 'token exchange').toBe(200);
  expect(tok.body.access_token, 'access token issued').toBeTruthy();

  const { client, transport } = await connectBearer(tok.body.access_token as string);
  const who = await callTool(client, 'whoami', {});
  expect(who.isError, `whoami: ${JSON.stringify(who.json)}`).toBe(false);
  const workspaces = who.json.workspaces as WhoamiWorkspace[];
  const personal = workspaces.find((w) => w.kind === 'personal');
  expect(personal, 'whoami lists the personal workspace').toBeTruthy();
  return {
    client,
    transport,
    email,
    workspace: (personal as WhoamiWorkspace).slug,
    workspaces,
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
