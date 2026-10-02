/**
 * The dashboard's body cap over a real HTTP server: a declared length over
 * the cap and a chunked body past it answer 413 before the handler runs (the
 * process keeps serving); a body within the cap reaches the handler byte for
 * byte, whether it is read through a web stream (what React Router's adapter
 * does) or `data` events, also when the whole request arrived before the cap
 * looked at it; exempt paths (matched after URL normalization) pass untouched.
 */
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DASHBOARD_MAX_BODY_BYTES_DEFAULT, dashboardMaxBodyBytes, withBodyLimit } from './body-limit.js';

const MAX = 64 * 1024;

interface Reply {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

let server: Server;
let port: number;
let handled: string[];

/** Reads the body like @react-router/express does: a web stream over the request. */
async function viaWebStream(req: IncomingMessage): Promise<Buffer> {
  const body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  return Buffer.from(await new Response(body).arrayBuffer());
}

function viaDataEvents(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sha = (b: Buffer) => `${b.length}:${b.subarray(0, 8).toString('hex')}:${b.subarray(-8).toString('hex')}`;

function handler(req: IncomingMessage, res: ServerResponse): void {
  handled.push(req.url ?? '');
  const read = req.url?.includes('events') ? viaDataEvents(req) : viaWebStream(req);
  void read.then((b) => res.end(sha(b)));
}

beforeAll(async () => {
  const capped = withBodyLimit(handler, { maxBytes: MAX, exempt: (p) => p.startsWith('/big/') });
  server = createServer((req, res) => {
    const next = (err?: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    };
    // `/late/…`: an async step in front of the cap — the whole request has arrived before it looks.
    if (req.url?.startsWith('/late/')) setTimeout(() => capped(req, res, next), 50);
    else capped(req, res, next);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  handled = [];
});

/**
 * One request; settles with the answer once it arrived — a connection the
 * server closes under the rest of an over-cap upload afterwards is fine, a
 * reset before any answer is `status: -1`.
 */
function send(path: string, opts: { body?: Buffer; chunked?: boolean; method?: string; abortAfter?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.body && !opts.chunked) headers['Content-Length'] = String(opts.body.length);
    if (opts.chunked) headers['Transfer-Encoding'] = 'chunked';
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: -1, body: '', headers: {} }) : reject(err)
    );
    if (opts.abortAfter !== undefined && opts.body) {
      req.write(opts.body.subarray(0, opts.abortAfter));
      setTimeout(() => {
        req.destroy();
        resolve({ status: 0, body: '', headers: {} });
      }, 50);
      return;
    }
    if (opts.body && opts.chunked) {
      for (let i = 0; i < opts.body.length; i += 1024) req.write(opts.body.subarray(i, i + 1024));
      req.end();
    } else {
      req.end(opts.body);
    }
  });
}

const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));

describe('DASHBOARD_MAX_BODY_BYTES', () => {
  it('1 MiB by default; a positive integer overrides it; anything else falls back', () => {
    expect(DASHBOARD_MAX_BODY_BYTES_DEFAULT).toBe(1024 * 1024);
    expect(dashboardMaxBodyBytes({})).toBe(1024 * 1024);
    expect(dashboardMaxBodyBytes({ DASHBOARD_MAX_BODY_BYTES: '2097152' })).toBe(2097152);
    for (const bad of ['0', '-1', '1.5', 'lots', '']) {
      expect(dashboardMaxBodyBytes({ DASHBOARD_MAX_BODY_BYTES: bad })).toBe(1024 * 1024);
    }
  });
});

describe('a declared Content-Length', () => {
  it('over the cap → 413 JSON with Connection: close, the handler never runs, the process keeps serving', async () => {
    const r = await send('/login', { body: bytes(MAX + 1) });
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe('close');
    expect(JSON.parse(r.body)).toMatchObject({ error: 'payload_too_large', details: { limit: 'DASHBOARD_MAX_BODY_BYTES', value: MAX } });
    expect(handled).toEqual([]);
    const ok = await send('/login', { body: bytes(10) });
    expect(ok).toMatchObject({ status: 200, body: sha(bytes(10)) });
  });

  it('within the cap reaches the handler intact (the parser never delivers more than declared)', async () => {
    const b = bytes(MAX);
    expect((await send('/oauth/token', { body: b })).body).toBe(sha(b));
    expect((await send('/oauth/token?events', { body: b })).body).toBe(sha(b));
  });

  it('a request without a body is handed over as it is', async () => {
    expect(await send('/login', { method: 'GET' })).toMatchObject({ status: 200, body: sha(Buffer.alloc(0)) });
  });
});

describe('a chunked body (no declared length)', () => {
  it('within the cap reaches the handler byte for byte — web stream or data events', async () => {
    for (const n of [1, 1000, MAX]) {
      const b = bytes(n);
      expect((await send('/oauth/token', { body: b, chunked: true })).body).toBe(sha(b));
      expect((await send('/oauth/token?events', { body: b, chunked: true })).body).toBe(sha(b));
    }
  });

  it('an empty one too', async () => {
    expect(await send('/login', { body: Buffer.alloc(0), chunked: true })).toMatchObject({ status: 200, body: sha(Buffer.alloc(0)) });
  });

  it('also when the whole request arrived before the cap looked at it', async () => {
    const b = bytes(3000);
    expect((await send('/late/a', { body: b, chunked: true })).body).toBe(sha(b));
    expect((await send('/late/a?events', { body: b, chunked: true })).body).toBe(sha(b));
    expect((await send('/late/b', { body: Buffer.alloc(0), chunked: true })).body).toBe(sha(Buffer.alloc(0)));
    expect((await send('/late/c', { body: bytes(MAX + 100), chunked: true })).status).toBe(413);
    expect(handled).toEqual(['/late/a', '/late/a?events', '/late/b']);
  });

  it('past the cap → 413, the rest is discarded, the handler never runs, the process keeps serving', async () => {
    const r = await send('/login', { body: bytes(4 * MAX), chunked: true });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'payload_too_large' });
    const burst = await Promise.all(Array.from({ length: 10 }, () => send('/oauth/token', { body: bytes(2 * MAX), chunked: true })));
    for (const s of burst) expect([413, -1]).toContain(s.status);
    expect(handled).toEqual([]);
    expect((await send('/login', { body: bytes(5), chunked: true })).body).toBe(sha(bytes(5)));
  });

  it('a client that goes away mid-body never reaches the handler', async () => {
    await send('/login', { body: bytes(MAX), chunked: true, abortAfter: 2048 });
    await new Promise((r) => setTimeout(r, 50));
    expect(handled).toEqual([]);
    expect((await send('/login', { method: 'GET' })).status).toBe(200);
  });
});

describe('exempt paths', () => {
  it('a path with its own limit is never capped here — declared or chunked', async () => {
    const b = bytes(3 * MAX);
    expect((await send('/big/import', { body: b })).body).toBe(sha(b));
    expect((await send('/big/import', { body: b, chunked: true })).body).toBe(sha(b));
  });

  it('is matched on the normalized path: dot segments cannot borrow an exemption', async () => {
    expect((await send('/big/../login', { body: bytes(MAX + 1) })).status).toBe(413);
    expect((await send('/big/%2e%2e/login', { body: bytes(MAX + 1) })).status).toBe(413);
    expect((await send('//evil.example/big/import', { body: bytes(MAX + 1) })).status).toBe(413);
    expect(handled).toEqual([]);
  });
});
