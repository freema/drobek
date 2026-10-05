/**
 * forwardToUpstream with `stream: true` against a real local server: only a
 * final, unencoded `text/event-stream` answer is relayed as it arrives (after
 * a followed redirect too); everything else stays buffered; the relayed
 * headers keep the allow-list, `no-store` and `nosniff` and add
 * `X-Accel-Buffering: no`; a cut stream ends with an SSE error event; the
 * response deadline comes from PROXY_RESPONSE_TIMEOUT_MS. No error or event
 * carries the injected secret.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from './crypto.server.js';
import { ProxyError } from './errors.js';
import { forwardToUpstream, sseCutEvent, type ForwardResult, type StreamedForwardResult } from './forward.server.js';
import type { UpstreamRecord } from './upstreams.server.js';

const KEY = ['sk', 'stream', 'k3y', String(Date.now())].join('-');

let server: http.Server;
let port: number;
const sent: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    switch (path) {
      case '/sse':
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'set-cookie': 'up=1', 'x-request-id': 'r1', 'cache-control': 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        res.write('event: a\ndata: 1\n\n');
        sent.push('a');
        setTimeout(() => {
          sent.push('b');
          res.end('event: b\ndata: 2\n\n');
        }, 250).unref();
        return;
      case '/to-sse':
        res.writeHead(302, { location: '/sse' });
        return res.end('moving');
      case '/sse-gzip': {
        const body = zlib.gzipSync(Buffer.from('data: zipped\n\n'));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': String(body.length) });
        return res.end(body);
      }
      case '/sse-error':
        res.writeHead(500, { 'content-type': 'text/event-stream' });
        return res.end('data: upstream failed\n\n');
      case '/sse-stall':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${req.headers['x-api-key'] ? 'keyed' : 'plain'}`);
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('slow');
        }, 600).unref();
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ PROXY_ALLOWED_HOSTS: '127.0.0.1', PROXY_ALLOWED_PORTS: String(port), DROBEK_MASTER_KEY: 'd'.repeat(64), ...over }) as NodeJS.ProcessEnv;

const upstream = (over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_1',
  workspaceId: 'ws_1',
  name: 'llm',
  baseUrl: `http://127.0.0.1:${port}`,
  allowedMethods: ['GET', 'HEAD', 'POST'],
  allowedPathPrefixes: ['/'],
  authType: 'none',
  authHeaderName: null,
  allowedAppIds: [],
  secret: null,
  ...over,
});

function call(path: string, opts: { method?: string; e?: NodeJS.ProcessEnv; up?: Partial<UpstreamRecord> } = {}) {
  return forwardToUpstream({
    upstream: upstream(opts.up),
    method: opts.method ?? 'GET',
    subpath: path,
    search: '',
    headers: new Headers(),
    env: opts.e ?? env(),
    stream: true,
  });
}

function isStreamed(r: ForwardResult | StreamedForwardResult): r is StreamedForwardResult {
  return 'streamEnd' in r;
}

async function text(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

describe('forwardToUpstream — stream: true', () => {
  it('an SSE answer is a Readable whose first event arrives before the upstream sends the last', async () => {
    sent.length = 0;
    const r = await call('/sse');
    expect(isStreamed(r)).toBe(true);
    const s = r as StreamedForwardResult;
    expect(s.body).toBeInstanceOf(Readable);
    const it = s.body[Symbol.asyncIterator]();
    const first = await it.next();
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe('event: a\ndata: 1\n\n');
    expect(sent).toEqual(['a']);
    let rest = '';
    for (let n = await it.next(); !n.done; n = await it.next()) rest += Buffer.from(n.value as Uint8Array).toString();
    expect(rest).toBe('event: b\ndata: 2\n\n');
    expect(await s.streamEnd).toMatchObject({ reason: 'end', bytes: 36 });
  });

  it('streamed headers: the allow-list, no-store, nosniff, X-Accel-Buffering: no — no Set-Cookie, no length', async () => {
    const r = (await call('/sse')) as StreamedForwardResult;
    await text(r.body);
    expect(r.headers).toEqual({
      date: expect.any(String),
      'content-type': 'text/event-stream; charset=utf-8',
      'x-request-id': 'r1',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
  });

  it('a redirect within the upstream, then SSE → streamed', async () => {
    const r = await call('/to-sse');
    expect(isStreamed(r)).toBe(true);
    expect(await text((r as StreamedForwardResult).body)).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
  });

  it('only SSE streams: JSON, an encoded SSE answer (decoded), HEAD and a stream: false call stay buffered', async () => {
    const json = await call('/json');
    expect(isStreamed(json)).toBe(false);
    expect((json as ForwardResult).body?.toString('utf8')).toBe('{"ok":true}');

    const gz = await call('/sse-gzip');
    expect(isStreamed(gz)).toBe(false);
    expect((gz as ForwardResult).body?.toString('utf8')).toBe('data: zipped\n\n');

    const head = await call('/sse', { method: 'HEAD' });
    expect(isStreamed(head)).toBe(false);
    expect((head as ForwardResult).body).toBeNull();

    const buffered = await forwardToUpstream({ upstream: upstream(), method: 'GET', subpath: '/sse', search: '', headers: new Headers(), env: env() });
    expect(Buffer.isBuffer(buffered.body)).toBe(true);
    expect(buffered.body!.toString('utf8')).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(buffered.headers['X-Accel-Buffering']).toBeUndefined();
  });

  it('an SSE answer with an error status is streamed as it is (the app reads the status)', async () => {
    const r = await call('/sse-error');
    expect(r.status).toBe(500);
    expect(await text((r as StreamedForwardResult).body)).toBe('data: upstream failed\n\n');
  });

  it('a stalled stream is cut by PROXY_STREAM_IDLE_TIMEOUT_MS with an SSE error event; nothing names the secret', async () => {
    const e = env({ PROXY_STREAM_IDLE_TIMEOUT_MS: '200' });
    const keyed = { authType: 'header' as const, authHeaderName: 'X-Api-Key', secret: encryptSecret(KEY, e) };
    const r = (await call('/sse-stall', { e, up: keyed })) as StreamedForwardResult;
    const out = await text(r.body);
    expect(out).toBe(
      'data: keyed\n\nevent: error\ndata: {"error":"upstream_error","message":"the upstream sent nothing for too long — the stream was cut","details":{"reason":"stream_idle"}}\n\n'
    );
    expect(out).not.toContain(KEY);
    expect((await r.streamEnd).reason).toBe('stream_idle');
  });

  it('PROXY_STREAM_MAX_BYTES cuts with stream_too_large', async () => {
    const r = (await call('/sse', { e: env({ PROXY_STREAM_MAX_BYTES: '20' }) })) as StreamedForwardResult;
    const out = await text(r.body);
    expect(out.startsWith('event: a\ndata: 1\n\nevent: error\n')).toBe(true);
    expect(out).toContain('"reason":"stream_too_large"');
  });

  it('the response deadline (PROXY_RESPONSE_TIMEOUT_MS) bounds the wait for headers; the error names no secret', async () => {
    const e = env({ PROXY_RESPONSE_TIMEOUT_MS: '200' });
    const keyed = { authType: 'bearer' as const, secret: encryptSecret(KEY, e) };
    const err = await call('/slow', { e, up: keyed }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProxyError);
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/timed out/);
    expect(JSON.stringify({ m: (err as Error).message, d: (err as ProxyError).details })).not.toContain(KEY);
    const ok = await call('/slow', { e: env({ PROXY_RESPONSE_TIMEOUT_MS: '5000' }) });
    expect((ok as ForwardResult).body?.toString()).toBe('slow');
  });
});

describe('sseCutEvent', () => {
  it('starts on its own event boundary whatever was relayed before', () => {
    const ev = 'event: error\ndata: {"error":"upstream_error","message":"the stream ran longer than allowed — it was cut","details":{"reason":"stream_too_long"}}\n\n';
    expect(sseCutEvent('stream_too_long', Buffer.from('\n\n')).toString()).toBe(ev);
    expect(sseCutEvent('stream_too_long', Buffer.from('x\n')).toString()).toBe(`\n${ev}`);
    expect(sseCutEvent('stream_too_long', Buffer.from('xy')).toString()).toBe(`\n\n${ev}`);
    expect(sseCutEvent('stream_too_long', Buffer.alloc(0)).toString()).toBe(ev);
  });
});
