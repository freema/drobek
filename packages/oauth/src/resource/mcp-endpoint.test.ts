/**
 * The `/mcp` HTTP endpoint on a real (PGlite) database and a real HTTP
 * listener: the body cap and its JSON-RPC errors, the catch around the
 * transport, closing the sessions for a shutdown, the access log, and the
 * session lifecycle — the idle TTL, the per-user cap, the grant a session is
 * bound to and closing on a revocation.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { REFRESH_RETRY_GRACE_MS } from '../constants.js';
import { freshDb } from '../test/db.js';
import { issueAccessAndRefresh, rotateRefreshToken } from '../tokens.server.js';
import { buildMcpServer, mountMcpEndpoint, type McpEndpoint, type McpEndpointOptions } from './mcp.js';
import { mcpResourceUri } from './oauth-resource.js';

const MAX_BODY = 4096;
const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'endpoint-test', version: '0' } },
});

let closeDb: () => Promise<void>;
let userId: string;
let readKey: string;
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
  readKey = (await createApiKey({ userId: u.id, name: 'endpoint test', scopes: ['read'] })).key;
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

afterEach(async () => {
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
  const h: Harness = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    endpoint,
    lines,
    stop: async () => {
      await endpoint.closeSessions();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  harnesses.push(h);
  return h;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${readKey}`, ...headers },
    body,
  });
}

async function initialize(h: Harness, bearer: string = readKey): Promise<string> {
  const auth = { authorization: `Bearer ${bearer}` };
  const res = await post(h.url, INITIALIZE, auth);
  expect(res.status).toBe(200);
  await res.text();
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  const ready = await post(h.url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
    ...auth,
    'mcp-session-id': sid as string,
  });
  expect(ready.status).toBe(202);
  await ready.text();
  return sid as string;
}

let pingId = 100;

/** A ping on session `sid`; the status and the body. */
async function ping(h: Harness, sid: string, bearer: string = readKey): Promise<{ status: number; body: string }> {
  const res = await post(h.url, JSON.stringify({ jsonrpc: '2.0', id: ++pingId, method: 'ping' }), {
    authorization: `Bearer ${bearer}`,
    'mcp-session-id': sid,
  });
  return { status: res.status, body: await res.text() };
}

const SESSION_GONE = { error: { code: -32001, message: 'MCP session not found — reconnect.' } };

function closedLines(h: Harness): LogMeta[] {
  return h.lines.filter((l) => l.message === 'mcp session closed').map((l) => l.meta);
}

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

  it('a body under the cap is served (initialize opens a session)', async () => {
    const h = await mount();
    await initialize(h);
    expect(h.endpoint.sessionCount()).toBe(1);
  });

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
  it('a throwing transport answers JSON-RPC 500, is logged and reported, and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const reported: ErrorReportEvent[] = [];
    installErrorReporter({ id: 'sink', label: 'Sink', report: (e) => void reported.push(e) }, {});
    try {
      const h = await mount({
        buildServer: () =>
          ({
            connect: async () => {
              throw new Error('transport exploded');
            },
          }) as unknown as McpServer,
      });
      const res = await post(h.url, INITIALIZE);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      await vi.waitFor(() => expect(reported).toHaveLength(1));
      expect(reported[0]).toMatchObject({
        message: 'mcp request failed',
        error: { message: 'transport exploded' },
        context: { kind: 'http', method: 'POST', route: '/mcp', status: 500 },
      });
      const failure = h.lines.find((l) => l.level === 'error');
      expect(failure?.message).toBe('mcp request failed');
      expect(String(failure?.meta.error)).toContain('transport exploded');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      resetErrorReporterForTests();
    }
  });
});

describe('closing the MCP sessions (shutdown)', () => {
  it('endListenStreams ends a GET listen stream at once and refuses new ones; POSTs keep working', async () => {
    const h = await mount();
    const sid = await initialize(h);
    const headers = { accept: 'text/event-stream', authorization: `Bearer ${readKey}`, 'mcp-session-id': sid };
    const stream = await fetch(h.url, { headers });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true;
    })();

    h.endpoint.endListenStreams();
    await expect(ended).resolves.toBe(true);

    const again = await fetch(h.url, { headers });
    expect(again.status).toBe(405);
    expect(again.headers.get('allow')).toBe('POST, DELETE');
    expect(await again.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });

    const ping = await post(h.url, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }), { 'mcp-session-id': sid });
    expect(ping.status).toBe(200);
    expect(await ping.text()).toContain('"id":5');

    // The listen stream logs one line when it closes, with how long it was open.
    await vi.waitFor(() => expect(h.lines.filter((l) => l.meta.method === 'GET')).toHaveLength(2));
    const listen = h.lines.find((l) => l.meta.method === 'GET' && l.meta.status === 200);
    expect(listen?.meta).toMatchObject({ session: sid.slice(0, 8), user_id: userId });
    expect(typeof listen?.meta.duration_ms).toBe('number');
  });

  it('closeSessions drops every session; its id then answers 404 so the client re-initializes', async () => {
    const h = await mount();
    const first = await initialize(h);
    await initialize(h);
    expect(h.endpoint.sessionCount()).toBe(2);

    await h.endpoint.closeSessions();
    expect(h.endpoint.sessionCount()).toBe(0);

    const gone = await post(h.url, JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }), { 'mcp-session-id': first });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: -32001, message: 'MCP session not found — reconnect.' } });
  });
});

describe('the /mcp access log', () => {
  it('one line per request: methods, tool, status, duration, short session id and user — never arguments or credentials', async () => {
    const h = await mount();
    const sid = await initialize(h);
    const call = await post(
      h.url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'write_files',
          arguments: { app_id: 'a1', files: [{ path: 'index.html', content: 'ARG-MARKER-123' }], reasoning: 'REASON-MARKER' },
        },
      }),
      { 'mcp-session-id': sid }
    );
    expect(call.status).toBe(200);
    await call.text();
    const anonymous = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: INITIALIZE });
    expect(anonymous.status).toBe(401);

    await vi.waitFor(() => expect(h.lines.filter((l) => l.message === 'mcp request')).toHaveLength(4));
    const lines = h.lines.filter((l) => l.message === 'mcp request');
    for (const l of lines) {
      expect(l.level).toBe('info');
      expect(typeof l.meta.duration_ms).toBe('number');
    }
    expect(lines.find((l) => l.meta.rpc === 'initialize')?.meta).toMatchObject({
      method: 'POST',
      status: 200,
      session: sid.slice(0, 8),
      user_id: userId,
    });
    expect(lines.find((l) => l.meta.rpc === 'notifications/initialized')?.meta).toMatchObject({ status: 202, session: sid.slice(0, 8) });
    expect(lines.find((l) => l.meta.rpc === 'tools/call')?.meta).toMatchObject({
      method: 'POST',
      rpc: 'tools/call',
      tool: 'write_files',
      status: 200,
      session: sid.slice(0, 8),
      user_id: userId,
    });
    const refused = lines.find((l) => l.meta.status === 401);
    expect(refused?.meta).toMatchObject({ method: 'POST' });
    expect(refused?.meta).not.toHaveProperty('user_id');

    const text = JSON.stringify(h.lines);
    expect(text).not.toContain(readKey);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('ARG-MARKER');
    expect(text).not.toContain('REASON-MARKER');
    expect(text).not.toContain('index.html');
    expect(text).not.toContain(sid);
  });
});

describe('the MCP session lifecycle', () => {
  const TTL = 60_000;

  it('a session without a request for the idle TTL is closed: its id answers 404, a new initialize works', async () => {
    let clock = 1_000_000;
    const h = await mount({ now: () => clock, sessionLimits: { idleTtlMs: TTL, perUser: 10 } });
    const sid = await initialize(h);

    clock += TTL - 1;
    expect((await ping(h, sid)).status).toBe(200);
    clock += TTL - 1;
    expect((await ping(h, sid)).status).toBe(200);

    clock += TTL;
    const gone = await ping(h, sid);
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body)).toMatchObject(SESSION_GONE);
    expect(h.endpoint.sessionCount()).toBe(0);
    expect(closedLines(h)).toEqual([{ reason: 'idle', session: sid.slice(0, 8), user_id: userId }]);

    await initialize(h);
    expect(h.endpoint.sessionCount()).toBe(1);
  });

  it('the idle sweep closes an idle session on its own; closeIdleSessions counts what it closed', async () => {
    let clock = 1_000_000;
    const h = await mount({ now: () => clock, sweepIntervalMs: 20, sessionLimits: { idleTtlMs: TTL, perUser: 10 } });
    await initialize(h);
    await initialize(h);
    expect(h.endpoint.closeIdleSessions()).toBe(0);

    clock += TTL;
    await vi.waitFor(() => expect(h.endpoint.sessionCount()).toBe(0));
    expect(closedLines(h).map((m) => m.reason)).toEqual(['idle', 'idle']);
    expect(h.endpoint.closeIdleSessions()).toBe(0);
  });

  it('an open request — a GET listen stream — keeps its session from going idle until it ends', async () => {
    let clock = 1_000_000;
    const h = await mount({ now: () => clock, sessionLimits: { idleTtlMs: TTL, perUser: 10 } });
    const sid = await initialize(h);
    const listening = new AbortController();
    const stream = await fetch(h.url, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${readKey}`, 'mcp-session-id': sid },
      signal: listening.signal,
    });
    expect(stream.status).toBe(200);

    clock += 3 * TTL;
    expect(h.endpoint.closeIdleSessions()).toBe(0);
    expect((await ping(h, sid)).status).toBe(200);

    listening.abort();
    await vi.waitFor(() => expect(h.lines.some((l) => l.message === 'mcp request' && l.meta.method === 'GET')).toBe(true));
    clock += TTL - 1;
    expect(h.endpoint.closeIdleSessions()).toBe(0);
    clock += 1;
    expect(h.endpoint.closeIdleSessions()).toBe(1);
    expect((await ping(h, sid)).status).toBe(404);
  });

  it("past the per-user cap a new session closes that user's least recently used one; other users are not counted", async () => {
    let clock = 1_000_000;
    const h = await mount({ now: () => clock, sessionLimits: { idleTtlMs: TTL, perUser: 2 } });
    const other = await initialize(h, otherKey);
    clock += 1_000;
    const first = await initialize(h);
    clock += 1_000;
    const second = await initialize(h);
    clock += 1_000;
    expect((await ping(h, first)).status).toBe(200);
    clock += 1_000;

    const third = await initialize(h);
    expect(h.endpoint.sessionCount()).toBe(3);
    const evicted = await ping(h, second);
    expect(evicted.status).toBe(404);
    expect(JSON.parse(evicted.body)).toMatchObject(SESSION_GONE);
    for (const sid of [first, third]) expect((await ping(h, sid)).status).toBe(200);
    expect((await ping(h, other, otherKey)).status).toBe(200);
    expect(closedLines(h)).toEqual([{ reason: 'limit', session: second.slice(0, 8), user_id: userId }]);
  });

  it('a session is driven only by the grant it was opened with: another key of the same user and scope gets 401', async () => {
    const h = await mount();
    const sid = await initialize(h);
    const second = (await createApiKey({ userId, name: 'second key', scopes: ['read'] })).key;
    const refused = await ping(h, sid, second);
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { message: 'Token does not match this MCP session.' } });
    expect((await ping(h, sid)).status).toBe(200);
  });

  it('revoking an API key closes its sessions and only those', async () => {
    const h = await mount();
    const doomed = await createApiKey({ userId, name: 'doomed', scopes: ['read'] });
    const sid = await initialize(h, doomed.key);
    const kept = await initialize(h);
    const foreign = await initialize(h, otherKey);

    expect(await revokeUserApiKey(userId, doomed.id)).not.toBeNull();
    await vi.waitFor(() => expect(h.endpoint.sessionCount()).toBe(2));
    expect(closedLines(h)).toEqual([{ reason: 'revoked', session: sid.slice(0, 8), user_id: userId }]);

    expect((await ping(h, sid, doomed.key)).status).toBe(401);
    expect((await ping(h, sid)).status).toBe(404);
    expect((await ping(h, kept)).status).toBe(200);
    expect((await ping(h, foreign, otherKey)).status).toBe(200);
  });

  it('an OAuth session survives a token refresh and is closed when the connection is revoked', async () => {
    const h = await mount();
    const client = await createClient({ clientName: 'Session test', redirectUris: ['http://127.0.0.1:9999/cb'] });
    const grant = { userId, oauthClientId: client.id, scope: 'read', audience: mcpResourceUri() };
    const issued = await issueAccessAndRefresh(grant);
    const sid = await initialize(h, issued.accessToken);
    const kept = await initialize(h);

    const rotated = await rotateRefreshToken(issued.refreshToken);
    expect(rotated.ok).toBe(true);
    const fresh = rotated.ok ? rotated.accessToken : '';
    expect((await ping(h, sid, fresh)).status).toBe(200);

    expect(await revokeConnection(userId, client.id)).not.toBeNull();
    await vi.waitFor(() => expect(h.endpoint.sessionCount()).toBe(1));
    expect(closedLines(h)).toEqual([{ reason: 'revoked', session: sid.slice(0, 8), user_id: userId }]);
    expect((await ping(h, sid)).status).toBe(404);
    expect((await ping(h, kept)).status).toBe(200);
  });

  it('refresh reuse detection closes the sessions its burnt lineage drove', async () => {
    const h = await mount();
    const client = await createClient({ clientName: 'Reuse test', redirectUris: ['http://127.0.0.1:9999/cb'] });
    const issued = await issueAccessAndRefresh({ userId, oauthClientId: client.id, scope: 'read', audience: mcpResourceUri() });
    const rotatedAt = Date.now();
    const rotated = await rotateRefreshToken(issued.refreshToken, undefined, rotatedAt);
    expect(rotated.ok).toBe(true);
    const sid = await initialize(h, rotated.ok ? rotated.accessToken : '');

    const reuse = await rotateRefreshToken(issued.refreshToken, undefined, rotatedAt + REFRESH_RETRY_GRACE_MS + 1);
    expect(reuse).toMatchObject({ ok: false, reuse: true });
    await vi.waitFor(() => expect(h.endpoint.sessionCount()).toBe(0));
    expect(closedLines(h)).toEqual([{ reason: 'revoked', session: sid.slice(0, 8), user_id: userId }]);
  });
});
