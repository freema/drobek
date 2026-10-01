/**
 * The `/mcp` HTTP endpoint on a real (PGlite) database and a real HTTP
 * listener: the body cap and its JSON-RPC errors, the catch around the
 * transport and the access log.
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
import { createApiKey } from '../api-keys.server.js';
import { freshDb } from '../test/db.js';
import { buildMcpServer, mountMcpEndpoint, type McpEndpointOptions } from './mcp.js';

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
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'http://drobek.test';
  delete process.env.PUBLIC_MCP_URL;
  const t = await freshDb();
  closeDb = () => t.pg.close();
  const [u] = await t.db.insert(users).values({ email: 'mcp-endpoint@example.test' }).returning();
  userId = u.id;
  readKey = (await createApiKey({ userId: u.id, name: 'endpoint test', scopes: ['read'] })).key;
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
  mountMcpEndpoint(app, {
    maxBodyBytes: MAX_BODY,
    log: captureLog(lines),
    buildServer: (ctx) => buildMcpServer(ctx, { leases: memoryLeaseStore(), notifyAppChanged: async () => {}, log: noopLogger }),
    ...opts,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const h: Harness = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    lines,
    stop: async () => {
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

async function initialize(h: Harness): Promise<string> {
  const res = await post(h.url, INITIALIZE);
  expect(res.status).toBe(200);
  await res.text();
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  const ready = await post(h.url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
    'mcp-session-id': sid as string,
  });
  expect(ready.status).toBe(202);
  await ready.text();
  return sid as string;
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
