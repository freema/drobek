import { once } from 'node:events';
import { Agent, createServer, request, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_GRACE_DEFAULT_MS, closeGracefully, shutdownGraceMs } from './graceful-close.js';

interface Reply {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
  socket: Socket;
}

const servers: Server[] = [];
const agents: Agent[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections();
  for (const a of agents.splice(0)) a.destroy();
});

/** A server whose `/slow` answers after 300 ms, `/hang` never; `received` resolves on each request's arrival. */
async function start(): Promise<{ server: Server; port: number; received: (path: string) => Promise<void> }> {
  const waiting = new Map<string, () => void>();
  const seen = new Set<string>();
  const handler: RequestListener = (req, res) => {
    const path = req.url ?? '/';
    seen.add(path);
    waiting.get(path)?.();
    if (path === '/slow') {
      setTimeout(() => res.end('slow done'), 300);
      return;
    }
    if (path === '/hang') return;
    res.end('ok');
  };
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const received = (path: string): Promise<void> =>
    seen.has(path) ? Promise.resolve() : new Promise<void>((resolve) => waiting.set(path, resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

function get(port: number, path: string, agent: Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers, socket: req.socket as Socket }));
    });
    req.on('error', reject);
    req.end();
  });
}

function keepAliveAgent(): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  return agent;
}

describe('shutdownGraceMs', () => {
  it('reads SHUTDOWN_GRACE_MS, else the 20 s default', () => {
    expect(SHUTDOWN_GRACE_DEFAULT_MS).toBe(20_000);
    expect(shutdownGraceMs({})).toBe(20_000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '5000' })).toBe(5000);
    for (const bad of ['', '0', '-1', '1.5', 'soon']) expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: bad }), bad).toBe(20_000);
  });
});

describe('closeGracefully', () => {
  it('lets a request in flight finish within the grace period', async () => {
    const { server, port, received } = await start();
    const reply = get(port, '/slow', keepAliveAgent());
    await received('/slow');
    const started = Date.now();
    const result = await closeGracefully(server, { graceMs: 5_000 });
    expect(result).toEqual({ drained: true });
    expect(await reply).toMatchObject({ status: 200, body: 'slow done' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
  });

  it('closes an idle keep-alive socket at once', async () => {
    const { server, port } = await start();
    const first = await get(port, '/', keepAliveAgent());
    expect(first.status).toBe(200);
    expect(first.socket.destroyed).toBe(false);
    const closed = once(first.socket, 'close');
    const started = Date.now();
    const result = await closeGracefully(server, { graceMs: 10_000 });
    await closed;
    expect(result).toEqual({ drained: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('destroys a request still running after the grace period and resolves', async () => {
    const { server, port, received } = await start();
    const reply = get(port, '/hang', keepAliveAgent()).then(
      () => null,
      (err: unknown) => err
    );
    await received('/hang');
    const started = Date.now();
    const result = await closeGracefully(server, { graceMs: 200 });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ drained: false });
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(2_000);
    expect(await reply).toBeInstanceOf(Error);
  });

  it('answers a request that arrives on an open socket during the drain with Connection: close', async () => {
    const { server, port, received } = await start();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => (raw += c));
    const ended = once(socket, 'close');
    socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
    await received('/slow');
    const closing = closeGracefully(server, { graceMs: 5_000 });
    socket.write('GET /after HTTP/1.1\r\nHost: x\r\n\r\n');
    const result = await closing;
    await ended;
    expect(result).toEqual({ drained: true });
    const answers = raw.split('HTTP/1.1 200 OK').slice(1);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toContain('slow done');
    expect(answers[1].toLowerCase()).toContain('connection: close');
    expect(answers[1]).toContain('ok');
  });
});
