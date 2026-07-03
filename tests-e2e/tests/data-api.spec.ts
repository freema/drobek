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
import { callTool, indexHtml, initUploadCommit } from './helpers/deploy';

/**
 * U10 acceptance (PHY-55 / PHY-56; PHY-63/71): drive the Data API as an MCP
 * client — collection_define with a JSON Schema → schema-honoring writes; an
 * invalid doc is rejected (422/validation_failed); record read/update/delete/
 * query round-trip. Access modes via the REST endpoints: locked rejects anon;
 * public-read allows anon GET but not POST; public-write allows anon POST
 * (schema still enforced). Quota caps create; a cross-workspace locator is
 * rejected (tenant isolation). Requires the local compose stack + worker.
 */

const REDIRECT_URI = 'http://127.0.0.1:9966/callback';
const DATA_SCOPE = 'mcp:whoami apps:read deploy:write data:read data:write';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL_WEB}/oauth/register`, {
    data: { client_name: 'drobek e2e data client', redirect_uris: [REDIRECT_URI] },
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
  opts: { clientId: string; challenge: string; resource: string }
): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    scope: DATA_SCOPE,
    resource: opts.resource,
    state: 'data-state',
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByTestId('consent-approve')).toBeVisible();
  const captured = new Promise<string>((resolve) => {
    void page.route(`${REDIRECT_URI.replace('/callback', '')}/**`, (route) => {
      const url = route.request().url();
      void route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
      resolve(url);
    });
  });
  await page.getByTestId('consent-approve').click();
  const capturedUrl = await captured;
  await page.unroute(`${REDIRECT_URI.replace('/callback', '')}/**`);
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
  expect(body.scope, 'data scopes granted').toContain('data:write');
  return body.access_token as string;
}

interface DataClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

/** Full login + consent(data:read/write + deploy:write) + connected MCP client. */
async function dataClient(
  page: Page,
  request: APIRequestContext,
  tag: string
): Promise<DataClient> {
  const resource = await mcpResource(request);
  const clientId = await registerClient(request);
  await loginViaEmail(page, request, uniqueEmail(tag));
  const { verifier, challenge } = pkcePair();
  const code = await consentAndGetCode(page, { clientId, challenge, resource });
  const accessToken = await exchangeCode(request, { code, verifier, clientId });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL_MCP}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
  const client = new Client({ name: 'drobek-e2e-data', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const TODO_SCHEMA = {
  type: 'object',
  required: ['title', 'done'],
  properties: {
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
  },
  additionalProperties: false,
};

/** Deploy a throwaway app so the data tools have a resolvable app to attach to. */
async function freshApp(
  client: Client,
  request: APIRequestContext
): Promise<{ workspace: string; slug: string }> {
  const salt = randomBytes(6).toString('hex');
  const dep = await initUploadCommit(client, request, {
    name: `E2E Data ${salt}`,
    files: [indexHtml(`data ${salt}`)],
  });
  return { workspace: dep.workspaceSlug, slug: dep.appSlug };
}

test('collection_define + schema-honoring CRUD round-trip via MCP @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await dataClient(page, request, 'data-crud');
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('collection_define');
    expect(tools).toContain('record_create');
    expect(tools).toContain('record_read');
    expect(tools).toContain('record_update');
    expect(tools).toContain('record_delete');
    expect(tools).toContain('record_query');

    const app = await freshApp(client, request);
    const locator = { workspace: app.workspace, slug: app.slug };

    const def = await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'todos',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });
    expect(def.isError, JSON.stringify(def.json)).toBe(false);

    // A schema-honoring doc is accepted.
    const created = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 'ship U10', done: false, priority: 1 },
    });
    expect(created.isError, JSON.stringify(created.json)).toBe(false);
    const id = created.json.id as string;
    expect(id).toBeTruthy();

    // An INVALID doc (missing required `done`) is rejected as validation_failed.
    const missing = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 'no done flag' },
    });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toBe('validation_failed');

    // A wrong-typed field is rejected too.
    const wrongType = await callTool(client, 'record_create', {
      locator,
      collection: 'todos',
      doc: { title: 42, done: true },
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.json.error).toBe('validation_failed');

    // read
    const read = await callTool(client, 'record_read', {
      locator,
      collection: 'todos',
      id,
    });
    expect(read.isError, JSON.stringify(read.json)).toBe(false);
    expect((read.json.doc as { title: string }).title).toBe('ship U10');

    // update (shallow-merge → re-validated)
    const updated = await callTool(client, 'record_update', {
      locator,
      collection: 'todos',
      id,
      patch: { done: true },
    });
    expect(updated.isError, JSON.stringify(updated.json)).toBe(false);
    expect((updated.json.doc as { done: boolean }).done).toBe(true);

    // query (equality filter on a schema field)
    const q = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { done: true },
    });
    expect(q.isError, JSON.stringify(q.json)).toBe(false);
    const records = q.json.records as { id: string }[];
    expect(records.some((r) => r.id === id)).toBe(true);

    // an unknown query field is rejected (whitelist / no injection)
    const badField = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { ssn: '123' },
    });
    expect(badField.isError).toBe(true);
    expect(badField.json.error).toBe('invalid_request');

    // delete → soft-delete → excluded from subsequent read + query
    const del = await callTool(client, 'record_delete', {
      locator,
      collection: 'todos',
      id,
    });
    expect(del.isError, JSON.stringify(del.json)).toBe(false);

    const readGone = await callTool(client, 'record_read', {
      locator,
      collection: 'todos',
      id,
    });
    expect(readGone.isError).toBe(true);
    expect(readGone.json.error).toBe('not_found');

    const qGone = await callTool(client, 'record_query', {
      locator,
      collection: 'todos',
      where: { done: true },
    });
    expect((qGone.json.records as { id: string }[]).some((r) => r.id === id)).toBe(
      false
    );
  } finally {
    await transport.close();
  }
});

test('REST access modes: locked rejects anon; public-read GET-only; public-write open (schema enforced) @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await dataClient(page, request, 'data-access');
  try {
    const app = await freshApp(client, request);
    const dataUrl = (coll: string, id?: string) =>
      `${BASE_URL_WEB}/${app.workspace}/app/${app.slug}/data/${coll}${id ? `/${id}` : ''}`;

    // ── locked ──────────────────────────────────────────────────────────────
    await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'locked_notes',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });
    // The `request` context carries NO session cookie → anonymous.
    const lockedGet = await request.get(dataUrl('locked_notes'));
    expect([401, 403]).toContain(lockedGet.status());
    const lockedPost = await request.post(dataUrl('locked_notes'), {
      data: { title: 'x', done: true },
    });
    expect([401, 403]).toContain(lockedPost.status());

    // ── public-read ─────────────────────────────────────────────────────────
    await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'public_read',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'public-read',
    });
    // Seed one doc as the author (MCP) so the anon GET has something to list.
    const seeded = await callTool(client, 'record_create', {
      locator: { workspace: app.workspace, slug: app.slug },
      collection: 'public_read',
      doc: { title: 'visible', done: false },
    });
    expect(seeded.isError, JSON.stringify(seeded.json)).toBe(false);

    const prGet = await request.get(dataUrl('public_read'));
    expect(prGet.status(), 'anon GET allowed on public-read').toBe(200);
    const prBody = (await prGet.json()) as { records: unknown[] };
    expect(Array.isArray(prBody.records)).toBe(true);
    expect(prBody.records.length).toBeGreaterThan(0);

    const prPost = await request.post(dataUrl('public_read'), {
      data: { title: 'anon', done: true },
    });
    expect(prPost.status(), 'anon POST rejected on public-read').toBe(401);

    // ── public-write ────────────────────────────────────────────────────────
    await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'guestbook',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'public-write',
    });
    const pwPost = await request.post(dataUrl('guestbook'), {
      data: { title: 'hello from anon', done: false },
    });
    expect(pwPost.status(), 'anon POST allowed on public-write').toBe(200);

    // …but the schema is STILL enforced on the anon write.
    const pwBad = await request.post(dataUrl('guestbook'), {
      data: { title: 'missing done flag' },
    });
    expect(pwBad.status(), 'schema still enforced on public-write').toBe(422);
  } finally {
    await transport.close();
  }
});

test('quota: exceeding DATA_MAX_DOCS_PER_APP rejects the create @local', async ({
  page,
  request,
}) => {
  skipUnlessLocal();
  const { client, transport } = await dataClient(page, request, 'data-quota');
  try {
    const app = await freshApp(client, request);
    const locator = { workspace: app.workspace, slug: app.slug };
    await callTool(client, 'collection_define', {
      workspace: app.workspace,
      slug: app.slug,
      name: 'capped',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });

    // The dev compose caps DATA_MAX_DOCS_PER_APP at 5 → the 6th create fails.
    let rejected = false;
    let rejectionCode: unknown;
    for (let i = 0; i < 20; i++) {
      const res = await callTool(client, 'record_create', {
        locator,
        collection: 'capped',
        doc: { title: `doc ${i}`, done: false },
      });
      if (res.isError) {
        rejected = true;
        rejectionCode = res.json.error;
        break;
      }
    }
    expect(rejected, 'a create was eventually rejected by the quota').toBe(true);
    expect(rejectionCode).toBe('too_many_docs');
  } finally {
    await transport.close();
  }
});

test('tenant isolation: a record op on another workspace than the token is rejected @local', async ({
  page,
  request,
  browser,
}) => {
  skipUnlessLocal();
  // Client A (this page) + its own app.
  const a = await dataClient(page, request, 'data-tenant-a');
  // Client B in an isolated browser context → a different user/workspace.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await dataClient(pageB, request, 'data-tenant-b');
  try {
    const appB = await freshApp(b.client, request);
    // B defines a collection in B's workspace.
    const defB = await callTool(b.client, 'collection_define', {
      workspace: appB.workspace,
      slug: appB.slug,
      name: 'secrets',
      jsonSchema: TODO_SCHEMA,
      accessMode: 'locked',
    });
    expect(defB.isError, JSON.stringify(defB.json)).toBe(false);

    // A (bound to workspace A) targets B's locator → rejected (not found).
    const cross = await callTool(a.client, 'record_create', {
      locator: { workspace: appB.workspace, slug: appB.slug },
      collection: 'secrets',
      doc: { title: 'steal', done: true },
    });
    expect(cross.isError, 'cross-workspace write must be rejected').toBe(true);
    expect(cross.json.error).toBe('not_found');
  } finally {
    await a.transport.close();
    await b.transport.close();
    await pageB.close();
    await ctxB.close();
  }
});
