/**
 * The connect timeout ends once the connection stands (a slow answer is the
 * deadline's business), and `streamUpstreamBody` relays an opened response
 * chunk by chunk within its byte cap, idle timer and maximum duration —
 * against real local servers.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyError } from './errors.js';
import {
  openUpstreamRequest,
  proxyResponseTimeoutMs,
  proxyStreamLimits,
  ssrfSafeForward,
  streamUpstreamBody,
  type StreamCutReason,
  type StreamEnd,
} from './ssrf.server.js';

const STEADY_CHUNK = 64 * 1024;
const STEADY_CHUNKS = 24;

let server: http.Server;
let port: number;
/** Resolves when the upstream side of the last /drip request closed. */
let upstreamClosed: Promise<void> = Promise.resolve();
const events: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/late-headers') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('late but fine');
      }, 1_500).unref();
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      events.push('sent one');
      setTimeout(() => {
        events.push('sent two');
        res.end('data: two\n\n');
      }, 300).unref();
      return;
    }
    if (url.pathname === '/chunks') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`data: ${'x'.repeat(92)}\n\n`);
        if (n === 10) {
          clearInterval(t);
          res.end();
        }
      }, 10);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (url.pathname === '/flood') {
      upstreamClosed = new Promise<void>((resolve) => res.on('close', () => resolve()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write(`data: ${'y'.repeat(64 * 1024)}\n\n`), 5);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (url.pathname === '/steady') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`data: ${'z'.repeat(STEADY_CHUNK - 8)}\n\n`);
        if (n === STEADY_CHUNKS) {
          clearInterval(t);
          res.end();
        }
      }, 25);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (url.pathname === '/drip' || url.pathname === '/stall') {
      upstreamClosed = new Promise<void>((resolve) => res.on('close', () => resolve()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      if (url.pathname === '/stall') return;
      const t = setInterval(() => res.write('data: more\n\n'), 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const allowLocal = (p = port): NodeJS.ProcessEnv =>
  ({ PROXY_ALLOWED_HOSTS: '127.0.0.1', PROXY_ALLOWED_PORTS: String(p) }) as NodeJS.ProcessEnv;
const url = (path: string) => new URL(`http://127.0.0.1:${port}${path}`);

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/** Open `path` and stream it with the given caps; `ended` settles with the finished() call. */
async function stream(path: string, caps: { idleMs?: number; maxMs?: number; maxBytes?: number } = {}) {
  const opened = await openUpstreamRequest({ url: url(path), method: 'GET', headers: {}, env: allowLocal() });
  let settle: (v: { err: ProxyError | null; end: StreamEnd }) => void = () => undefined;
  const ended = new Promise<{ err: ProxyError | null; end: StreamEnd }>((resolve) => {
    settle = resolve;
  });
  let calls = 0;
  const body = streamUpstreamBody(opened, {
    idleMs: caps.idleMs ?? 5_000,
    maxMs: caps.maxMs ?? 10_000,
    maxBytes: caps.maxBytes ?? 1024 * 1024,
    trailer: (reason: StreamCutReason) => Buffer.from(`[cut: ${reason}]`),
    finished: (err, end) => {
      calls += 1;
      settle({ err, end });
    },
  });
  return { opened, body, ended, calls: () => calls };
}

describe('the connect timeout covers only the connect', () => {
  it('headers after 1.5 s with a 200 ms connect timeout still arrive (buffered, no deadline)', async () => {
    const r = await ssrfSafeForward({ url: url('/late-headers'), method: 'GET', headers: {}, env: allowLocal(), timeoutMs: 200 });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('late but fine');
  });

  it('the same with PROXY_CONNECT_TIMEOUT_MS=200 from the env', async () => {
    const env = { ...allowLocal(), PROXY_CONNECT_TIMEOUT_MS: '200' } as NodeJS.ProcessEnv;
    const r = await ssrfSafeForward({ url: url('/late-headers'), method: 'GET', headers: {}, env, deadlineMs: 5_000 });
    expect(r.body.toString()).toBe('late but fine');
  });

  it('a TLS handshake that never completes → upstream_error "timed out" after the connect timeout', async () => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      const started = Date.now();
      const err = await ssrfSafeForward({
        url: new URL(`https://127.0.0.1:${silentPort}/`),
        method: 'GET',
        headers: {},
        env: allowLocal(silentPort),
        timeoutMs: 200,
      }).catch((e: unknown) => e);
      expect((err as ProxyError).code).toBe('upstream_error');
      expect((err as Error).message).toMatch(/timed out/);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      silent.close();
    }
  });

  it('the deadline still bounds the wait for headers', async () => {
    const err = await ssrfSafeForward({ url: url('/late-headers'), method: 'GET', headers: {}, env: allowLocal(), timeoutMs: 200, deadlineMs: 300 }).catch(
      (e: unknown) => e
    );
    expect((err as ProxyError).code).toBe('upstream_error');
    expect((err as Error).message).toMatch(/timed out/);
  });

  it('an aborted signal rejects openUpstreamRequest with its ProxyError', async () => {
    const ctrl = new AbortController();
    const pending = openUpstreamRequest({ url: url('/late-headers'), method: 'GET', headers: {}, env: allowLocal(), signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new ProxyError('upstream_error', 'upstream request timed out')), 50);
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/timed out/);
  });
});

describe('env defaults', () => {
  it('PROXY_RESPONSE_TIMEOUT_MS 120 s; stream idle 60 s, max 5 min, 32 MiB', () => {
    expect(proxyResponseTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000);
    expect(proxyResponseTimeoutMs({ PROXY_RESPONSE_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5_000);
    expect(proxyStreamLimits({} as NodeJS.ProcessEnv)).toEqual({ idleMs: 60_000, maxMs: 300_000, maxBytes: 33_554_432 });
    expect(
      proxyStreamLimits({ PROXY_STREAM_IDLE_TIMEOUT_MS: '1', PROXY_STREAM_MAX_MS: 'x', PROXY_STREAM_MAX_BYTES: '-5' } as NodeJS.ProcessEnv)
    ).toEqual({ idleMs: 1, maxMs: 300_000, maxBytes: 33_554_432 });
  });
});

describe('streamUpstreamBody', () => {
  it('relays the first chunk before the upstream sends the last; ends with reason end', async () => {
    events.length = 0;
    const s = await stream('/sse');
    const it = s.body[Symbol.asyncIterator]();
    const first = await it.next();
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe('data: one\n\n');
    expect(events).toEqual(['sent one']);
    let rest = '';
    for (let r = await it.next(); !r.done; r = await it.next()) rest += Buffer.from(r.value as Uint8Array).toString();
    expect(rest).toBe('data: two\n\n');
    const { err, end } = await s.ended;
    expect(err).toBeNull();
    expect(end).toMatchObject({ reason: 'end', bytes: 22 });
    expect(s.calls()).toBe(1);
  });

  it('the byte cap cuts mid-stream: the chunks within it, then the trailer; the upstream is closed', async () => {
    const s = await stream('/chunks', { maxBytes: 250 });
    const text = await collect(s.body);
    expect(text).toBe(`${`data: ${'x'.repeat(92)}\n\n`.repeat(2)}[cut: stream_too_large]`);
    const { end } = await s.ended;
    expect(end).toMatchObject({ reason: 'stream_too_large', bytes: 200 });
    expect(s.opened.response.destroyed).toBe(true);
  });

  it('no byte for idleMs → cut with stream_idle', async () => {
    const s = await stream('/stall', { idleMs: 200 });
    const text = await collect(s.body);
    expect(text).toBe('data: first\n\n[cut: stream_idle]');
    expect((await s.ended).end.reason).toBe('stream_idle');
    await upstreamClosed;
  });

  it('an upstream silent for idleMs is cut with stream_idle although the client reads at once', async () => {
    const started = Date.now();
    const s = await stream('/stall', { idleMs: 250, maxMs: 10_000 });
    const it = s.body[Symbol.asyncIterator]();
    expect(Buffer.from((await it.next()).value as Uint8Array).toString()).toBe('data: first\n\n');
    const { end } = await s.ended;
    expect(end.reason).toBe('stream_idle');
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(Date.now() - started).toBeLessThan(2_000);
    await upstreamClosed;
  });

  it('a client that reads slower than idleMs is not cut for idle while the upstream keeps sending', async () => {
    const s = await stream('/steady', { idleMs: 150, maxMs: 20_000, maxBytes: 64 * 1024 * 1024 });
    let received = 0;
    let reads = 0;
    for await (const c of s.body) {
      received += (c as Uint8Array).length;
      reads += 1;
      if (reads <= 4) await new Promise((r) => setTimeout(r, 400));
    }
    const { err, end } = await s.ended;
    expect(err).toBeNull();
    expect(end.reason).toBe('end');
    expect(received).toBe(STEADY_CHUNK * STEADY_CHUNKS);
    expect(end.bytes).toBe(STEADY_CHUNK * STEADY_CHUNKS);
  });

  it('a stream that keeps sending is cut at maxMs (stream_too_long)', async () => {
    const started = Date.now();
    const s = await stream('/drip', { maxMs: 300 });
    const text = await collect(s.body);
    expect(text.startsWith('data: first\n\n')).toBe(true);
    expect(text.endsWith('[cut: stream_too_long]')).toBe(true);
    const { end } = await s.ended;
    expect(end.reason).toBe('stream_too_long');
    expect(Date.now() - started).toBeLessThan(2_000);
    await upstreamClosed;
  });

  it('a client that stops reading cannot hold the stream past maxMs + idleMs: the Readable is destroyed', async () => {
    const started = Date.now();
    const s = await stream('/flood', { maxMs: 200, idleMs: 300, maxBytes: 64 * 1024 * 1024 });
    const { end } = await s.ended;
    expect(end.reason).toBe('stream_too_long');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(s.body.destroyed).toBe(true);
    await upstreamClosed;
  });

  it('destroying the Readable (the client left) closes the upstream connection; reason client_closed, once', async () => {
    const s = await stream('/drip');
    const it = s.body[Symbol.asyncIterator]();
    await it.next();
    s.body.destroy();
    await upstreamClosed;
    const { err, end } = await s.ended;
    expect(err).toBeNull();
    expect(end.reason).toBe('client_closed');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.calls()).toBe(1);
  });

  it('the upstream dropping the connection mid-stream → the Readable errors; reason upstream_error', async () => {
    const s = await stream('/drip');
    const it = s.body[Symbol.asyncIterator]();
    await it.next();
    server.closeAllConnections();
    const err = await (async () => {
      for (let r = await it.next(); !r.done; r = await it.next()) {
        /* drain */
      }
    })().catch((e: unknown) => e);
    expect((err as ProxyError).code).toBe('upstream_error');
    const ended = await s.ended;
    expect(ended.end.reason).toBe('upstream_error');
    expect(ended.err?.code).toBe('upstream_error');
  });
});
