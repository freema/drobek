/**
 * The stateless `/mcp` endpoint on a real (PGlite) database and a real HTTP
 * listener, driven by the SDK v2 client in both eras: a 2026-07-28 client
 * (pinned) and a 2025 client (`initialize`, no session). Covers the body cap
 * and its JSON-RPC errors, the failures, revocation on the next request, two
 * users in parallel, the SDK's own refusals (405, header mismatch, the
 * subscription limit), the shutdown order, a client that outlives a restart
 * and the access log.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installErrorReporter,
  noopLogger,
  resetErrorReporterForTests,
  type ErrorReportEvent,
  type LogMeta,
  type Logger,
} from '@drobek/core';
import { users } from '@drobek/db';
import { memoryLeaseStore } from '@drobek/mcp';
import { createApiKey, revokeUserApiKey } from '../api-keys.server.js';
import { createClient } from '../clients.server.js';
import { revokeConnection } from '../connections.server.js';
import { freshDb } from '../test/db.js';
import { issueAccessAndRefresh } from '../tokens.server.js';
import {
  buildMcpServer,
  MCP_MAX_SUBSCRIPTIONS_DEFAULT,
  mcpMaxSubscriptions,
  mountMcpEndpoint,
  type McpEndpoint,
  type McpEndpointOptions,
} from './mcp.js';
import { mcpResourceUri } from './oauth-resource.js';

const MAX_BODY = 4096;
const MODERN = '2026-07-28';
const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'endpoint-test', version: '0' } },
});

type Era = 'modern' | 'legacy';
const ERAS: Era[] = ['modern', 'legacy'];

let closeDb: () => Promise<void>;
let userId: string;
let otherUserId: string;
let readKey: string;
let writeKey: string;
let otherKey: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'http://drobek.test';
  delete process.env.PUBLIC_MCP_URL;
  const t = await freshDb();
  closeDb = () => t.pg.close();
  const [u] = await t.db.insert(users).values({ email: 'mcp-endpoint@example.test' }).returning();
  const [o] = await t.db.insert(users).values({ email: 'mcp-endpoint-other@example.test' }).returning();
  userId = u.id;
  otherUserId = o.id;
  readKey = (await createApiKey({ userId: u.id, name: 'endpoint test', scopes: ['read'] })).key;
  writeKey = (await createApiKey({ userId: u.id, name: 'endpoint write', scopes: ['read', 'write'] })).key;
  otherKey = (await createApiKey({ userId: o.id, name: 'other user', scopes: ['read'] })).key;
});

afterAll(async () => {
  process.env = { ...savedEnv };
  await closeDb();
});

interface Logged {
  level: string;
  message: string;
  meta: LogMeta;
}

interface Harness {
  url: string;
  endpoint: McpEndpoint;
  lines: Logged[];
  stop: () => Promise<void>;
}

const harnesses: Harness[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const h of harnesses.splice(0)) await h.stop();
});

function captureLog(lines: Logged[]): Logger {
  const at = (level: string) => (message: string, meta: LogMeta = {}) => void lines.push({ level, message, meta });
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

async function mount(opts: McpEndpointOptions = {}): Promise<Harness> {
  const lines: Logged[] = [];
  const app = express();
  const endpoint = mountMcpEndpoint(app, {
    maxBodyBytes: MAX_BODY,
    log: captureLog(lines),
    buildServer: (ctx) => buildMcpServer(ctx, { leases: memoryLeaseStore(), notifyAppChanged: async () => {}, log: noopLogger }),
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let stopped = false;
  const h: Harness = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    endpoint,
    lines,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await endpoint.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  harnesses.push(h);
  return h;
}

/** An SDK v2 client: `modern` pins 2026-07-28, `legacy` is the default 2025 handshake, `auto` negotiates. */
async function connect(
  target: string | (() => string),
  era: Era | 'auto',
  bearer: string = readKey
): Promise<Client> {
  const client = new Client(
    { name: 'endpoint-test', version: '0' },
    era === 'legacy' ? {} : { versionNegotiation: { mode: era === 'modern' ? { pin: MODERN } : 'auto' } }
  );
  const url = typeof target === 'string' ? () => target : target;
  const transport = new StreamableHTTPClientTransport(new URL(url()), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: (_input, init) => fetch(url(), init),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${readKey}`, ...headers },
    body,
  });
}

/** A hand-built 2026-07-28 request: the `_meta` envelope and the standard headers. */
function modernRequest(id: number, method: string, params: Record<string, unknown> = {}): { body: string; headers: Record<string, string> } {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
  return {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'raw-test', version: '0' },
        },
      },
    }),
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
  };
}

function structured(res: unknown): Record<string, unknown> {
  return ((res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}) as Record<string, unknown>;
}

function accessLines(h: Harness): LogMeta[] {
  return h.lines.filter((l) => l.message === 'mcp request').map((l) => l.meta);
}

describe('MCP_MAX_SUBSCRIPTIONS', () => {
  it('defaults to 256; a positive integer overrides it; anything else keeps the default', () => {
    expect(MCP_MAX_SUBSCRIPTIONS_DEFAULT).toBe(256);
    expect(mcpMaxSubscriptions({})).toBe(256);
    expect(mcpMaxSubscriptions({ MCP_MAX_SUBSCRIPTIONS: '16' })).toBe(16);
    for (const bad of ['0', '-3', '1.5', 'many', '']) expect(mcpMaxSubscriptions({ MCP_MAX_SUBSCRIPTIONS: bad }), bad).toBe(256);
  });
});

describe('the 2026-07-28 era (no initialize, no session)', () => {
  it('tools/list and tools/call work without initialize; the scope decides the tools', async () => {
    const h = await mount();
    const client = await connect(h.url, 'modern');
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('list_apps');
    expect(tools).not.toContain('write_files');

    const listed = await client.callTool({ name: 'list_apps', arguments: {} });
    expect(structured(listed)).toMatchObject({ user: { email: 'mcp-endpoint@example.test' } });

    const refused = await client.callTool({ name: 'write_files', arguments: { app_id: 'x', files: [], reasoning: 'r' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('MCP error -32602: Tool write_files not found');

    const writer = await connect(h.url, 'modern', writeKey);
    expect((await writer.listTools()).tools.map((t) => t.name)).toContain('write_files');
  });

  it('a tool on an app the caller is not a member of answers not_found', async () => {
    const h = await mount();
    const client = await connect(h.url, 'modern');
    const res = await client.callTool({ name: 'get_app', arguments: { app_id: 'no-such-app-0000000000' } });
    expect(res.isError).toBe(true);
    expect(structured(res)).toMatchObject({ code: 'not_found' });
  });

  it('tools/list, resources/list and prompts/list carry a private 5-minute cache hint', async () => {
    const h = await mount();
    for (const method of ['tools/list', 'resources/list', 'prompts/list']) {
      const req = modernRequest(7, method);
      const res = await post(h.url, req.body, req.headers);
      expect(res.status, method).toBe(200);
      const body = (await res.json()) as { result: Record<string, unknown> };
      expect(body.result, method).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
    }
  });

  it('an Mcp-Method header that contradicts the body is refused by the SDK with a 4xx, not a crash', async () => {
    const h = await mount();
    const req = modernRequest(8, 'tools/list');
    const res = await post(h.url, req.body, { ...req.headers, 'mcp-method': 'tools/call' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).not.toBe(-32603);
    expect(h.lines.some((l) => l.level === 'error')).toBe(false);
  });

  it('past MCP_MAX_SUBSCRIPTIONS open listen streams a new one answers -32603 "Subscription limit reached"', async () => {
    const h = await mount({ maxSubscriptions: 1 });
    const client = await connect(h.url, 'modern');
    const first = await client.listen({ toolsListChanged: true });
    expect(first.honoredFilter).toEqual({ toolsListChanged: true });

    const req = modernRequest(9, 'subscriptions/listen', { notifications: { toolsListChanged: true } });
    const res = await post(h.url, req.body, req.headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Subscription limit reached');
    await first.close();
  });
});

describe('the 2025 era (initialize from a fresh instance, no session)', () => {
  it('initialize answers the instructions and no Mcp-Session-Id; tools/call then works', async () => {
    const h = await mount();
    const res = await post(h.url, INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const text = await res.text();
    expect(text).toContain('"instructions"');
    expect(text).toContain('"protocolVersion":"2025-06-18"');

    const client = await connect(h.url, 'legacy');
    expect(client.getInstructions()).toBeTruthy();
    const listed = await client.callTool({ name: 'list_apps', arguments: {} });
    expect(structured(listed)).toMatchObject({ user: { email: 'mcp-endpoint@example.test' } });
  });

  it('a request still carrying an Mcp-Session-Id from before the upgrade is served', async () => {
    const h = await mount();
    const res = await post(
      h.url,
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      { 'mcp-session-id': '5f8a7c3e-0d4b-4c1e-9a7f-2b6d8e1c3a90', 'mcp-protocol-version': '2025-06-18' }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('list_apps');
  });

  it("an 'auto' client negotiates 2026-07-28 by itself", async () => {
    const h = await mount();
    const client = await connect(h.url, 'auto');
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(accessLines(h).some((l) => l.protocol === MODERN && l.rpc === 'tools/list')).toBe(true));
  });

  it('GET and DELETE answer 405 with Allow: POST', async () => {
    const h = await mount();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(h.url, { method, headers: { accept: 'text/event-stream', authorization: `Bearer ${readKey}` } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('POST');
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    }
  });
});

describe('/mcp request bodies', () => {
  it('a body over the cap answers 413 with a JSON-RPC error naming the limit and how to split the write', async () => {
    const h = await mount();
    const res = await post(
      h.url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'write_files', arguments: { files: [{ path: 'a.txt', content: 'x'.repeat(MAX_BODY) }] } },
      })
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { jsonrpc: string; id: null; error: { code: number; message: string } };
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(body.error.message).toContain(`over ${MAX_BODY} bytes`);
    expect(body.error.message).toContain('MCP_MAX_BODY_BYTES');
    expect(body.error.message).toContain('split the write into several write_files calls, or send edits');
  });

  it.each(ERAS)('%s: a 5 MiB write_files passes (over the SDK default, under the cap); 11 MiB answers our 413', async (era) => {
    const h = await mount({ maxBodyBytes: 10 * 1024 * 1024 });
    const client = await connect(h.url, era, writeKey);
    const files = (bytes: number) => [{ path: 'big.txt', content: 'x'.repeat(bytes) }];
    const passed = await client.callTool({ name: 'write_files', arguments: { app_id: 'no-such-app-0000000000', files: files(5 * 1024 * 1024), reasoning: 'big' } });
    expect(structured(passed)).toMatchObject({ code: 'not_found' });

    await expect(
      client.callTool({ name: 'write_files', arguments: { app_id: 'no-such-app-0000000000', files: files(11 * 1024 * 1024), reasoning: 'too big' } })
    ).rejects.toThrow();
    await vi.waitFor(() => expect(accessLines(h).filter((l) => l.status === 413)).toHaveLength(1));
  }, 30_000);

  it('malformed JSON answers 400 with a JSON-RPC parse error', async () => {
    const h = await mount();
    const res = await post(h.url, '{"jsonrpc": "2.0", "id": 1, "method": ');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });

  it('the Bearer is checked before the body is read: no token answers 401 even for an oversized body', async () => {
    const h = await mount();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(4 * MAX_BODY) }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

describe('/mcp failures', () => {
  it('a throwing server factory answers JSON-RPC -32603, is logged and reported, and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const reported: ErrorReportEvent[] = [];
    installErrorReporter({ id: 'sink', label: 'Sink', report: (e) => void reported.push(e) }, {});
    try {
      const h = await mount({
        buildServer: (): McpServer => {
          throw new Error('factory exploded');
        },
      });
      const res = await post(h.url, INITIALIZE);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32603 } });
      await vi.waitFor(() => expect(reported).toHaveLength(1));
      expect(reported[0]).toMatchObject({
        message: 'mcp request failed',
        error: { message: 'factory exploded' },
        context: { kind: 'http', method: 'POST', route: '/mcp', status: 500 },
      });
      const failure = h.lines.find((l) => l.level === 'error');
      expect(failure?.message).toBe('mcp request failed');
      expect(String(failure?.meta.error)).toContain('factory exploded');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      resetErrorReporterForTests();
    }
  });
});

describe('revocation applies on the next request', () => {
  it.each(ERAS)('%s: a revoked API key gets 401 on its next request; another key goes on', async (era) => {
    const h = await mount();
    const doomed = await createApiKey({ userId, name: `doomed ${era}`, scopes: ['read'] });
    const client = await connect(h.url, era, doomed.key);
    const kept = await connect(h.url, era);
    await client.callTool({ name: 'list_apps', arguments: {} });

    expect(await revokeUserApiKey(userId, doomed.id)).not.toBeNull();
    await expect(client.callTool({ name: 'list_apps', arguments: {} })).rejects.toThrow();
    await vi.waitFor(() => expect(accessLines(h).some((l) => l.status === 401)).toBe(true));
    await expect(kept.callTool({ name: 'list_apps', arguments: {} })).resolves.toBeTruthy();
  });

  it.each(ERAS)('%s: a revoked OAuth connection gets 401 on its next request', async (era) => {
    const h = await mount();
    const oauthClient = await createClient({ clientName: `Revoke ${era}`, redirectUris: ['http://127.0.0.1:9999/cb'] });
    const issued = await issueAccessAndRefresh({ userId, oauthClientId: oauthClient.id, scope: 'read', audience: mcpResourceUri() });
    const client = await connect(h.url, era, issued.accessToken);
    await client.callTool({ name: 'list_apps', arguments: {} });

    expect(await revokeConnection(userId, oauthClient.id)).not.toBeNull();
    await expect(client.callTool({ name: 'list_apps', arguments: {} })).rejects.toThrow();
    await vi.waitFor(() => expect(accessLines(h).some((l) => l.status === 401)).toBe(true));
  });
});

describe('two users at once', () => {
  it.each(ERAS)('%s: concurrent requests of two users never see each other', async (era) => {
    const h = await mount();
    const mine = await connect(h.url, era);
    const theirs = await connect(h.url, era, otherKey);
    const calls: [string, Client][] = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? ['mine', mine] : ['theirs', theirs]));
    const results = await Promise.all(
      calls.map(async ([who, c]) => ({ who, body: structured(await c.callTool({ name: 'list_apps', arguments: {} })) }))
    );
    for (const { who, body } of results) {
      expect((body.user as { email: string }).email).toBe(who === 'mine' ? 'mcp-endpoint@example.test' : 'mcp-endpoint-other@example.test');
    }
    const ids = new Set(accessLines(h).filter((l) => l.tool === 'list_apps').map((l) => l.user_id));
    expect(ids).toEqual(new Set([userId, otherUserId]));
  });
});

describe('a restart is invisible to a client', () => {
  it.each(ERAS)('%s: the next request of the same client goes to a new endpoint instance without reconnecting', async (era) => {
    const first = await mount();
    let target = first.url;
    const client = await connect(() => target, era);
    await client.callTool({ name: 'list_apps', arguments: {} });

    await first.stop();
    const second = await mount();
    target = second.url;
    const again = await client.callTool({ name: 'list_apps', arguments: {} });
    expect(structured(again)).toMatchObject({ user: { email: 'mcp-endpoint@example.test' } });
    expect(accessLines(second).some((l) => l.tool === 'list_apps' && l.status === 200)).toBe(true);
  });
});

describe('the shutdown', () => {
  it('stop: a tools/call in flight completes, a new request gets 503 with Retry-After, the listen stream closes; close after the drain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    const h = await mount({
      buildServer: () => {
        const server = new McpServer({ name: 'slow', version: '0' });
        server.registerTool('zz_slow', { description: 'waits for the test' }, async () => {
          entered();
          await gate;
          return { content: [{ type: 'text', text: 'done' }] };
        });
        return server;
      },
    });
    const client = await connect(h.url, 'modern');
    const subscription = await client.listen({ toolsListChanged: true });
    const slow = client.callTool({ name: 'zz_slow', arguments: {} });
    await inFlight;

    h.endpoint.stop();
    await expect(subscription.closed).resolves.toMatch(/graceful|remote/);

    const refused = await post(h.url, modernRequest(11, 'tools/list').body, modernRequest(11, 'tools/list').headers);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(await refused.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });

    release();
    await expect(slow).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
    await h.endpoint.close();
  });
});

describe('the /mcp access log', () => {
  it('one line per request: methods, tool, protocol, Mcp-Method/Mcp-Name, status, duration and user — never arguments or credentials', async () => {
    const h = await mount();
    const call = modernRequest(3, 'tools/call', {
      name: 'list_apps',
      arguments: { workspace: 'ARG-MARKER-123', reasoning: 'REASON-MARKER' },
    });
    const res = await post(h.url, call.body, call.headers);
    expect(res.status).toBe(200);
    await res.text();
    const legacy = await post(h.url, INITIALIZE);
    expect(legacy.status).toBe(200);
    await legacy.text();
    const plain = await post(h.url, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }));
    await plain.text();
    const anonymous = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: INITIALIZE });
    expect(anonymous.status).toBe(401);

    await vi.waitFor(() => expect(accessLines(h)).toHaveLength(4));
    for (const l of h.lines.filter((x) => x.message === 'mcp request')) {
      expect(l.level).toBe('info');
      expect(typeof l.meta.duration_ms).toBe('number');
    }
    const lines = accessLines(h);
    expect(lines.find((l) => l.rpc === 'tools/call')).toMatchObject({
      method: 'POST',
      rpc: 'tools/call',
      tool: 'list_apps',
      protocol: MODERN,
      mcp_method: 'tools/call',
      mcp_name: 'list_apps',
      status: 200,
      user_id: userId,
    });
    expect(lines.find((l) => l.rpc === 'initialize')).toMatchObject({ status: 200, protocol: '2025-06-18', user_id: userId });
    expect(lines.find((l) => l.rpc === 'tools/list')).toMatchObject({ status: 200, protocol: 'legacy' });
    expect(lines.find((l) => l.rpc === 'tools/list')).not.toHaveProperty('mcp_method');
    const refused = lines.find((l) => l.status === 401);
    expect(refused).toMatchObject({ method: 'POST' });
    expect(refused).not.toHaveProperty('user_id');
    for (const l of lines) expect(l).not.toHaveProperty('session');

    const text = JSON.stringify(h.lines);
    expect(text).not.toContain(readKey);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('ARG-MARKER');
    expect(text).not.toContain('REASON-MARKER');
  });
});
