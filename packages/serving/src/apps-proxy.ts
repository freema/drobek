/**
 * The apps-host reverse proxy of path routing (`APPS_ROUTING_MODE=path`).
 *
 * A platform that gives every service exactly one generated hostname (and no
 * wildcard) cannot point a second hostname at the drobek service. This proxy
 * runs as its own small service from the same image, owns the apps hostname
 * (`APPS_BASE_URL`) and forwards every request to drobek over the private
 * network with `Host` forced to the apps host — so drobek classifies it as the
 * apps side exactly as if the client had reached it directly.
 *
 *  - `Host` is ALWAYS the apps host: the proxy can never reach the dashboard,
 *    its API, MCP or OAuth, whatever the client sent.
 *  - `X-Forwarded-Host`, `Forwarded` and the hop-by-hop headers are dropped.
 *  - The client IP drobek sees: the incoming `X-Real-IP`, else the rightmost
 *    `X-Forwarded-For` hop (the platform edge), else the TCP peer — sent as
 *    both `X-Real-IP` and a one-hop `X-Forwarded-For`.
 *  - Bodies stream both ways unbuffered (uploads, server-sent events).
 *  - `GET /healthz` is answered by the proxy itself (path routing serves
 *    nothing outside `/apps/` and the shared SDK scripts).
 *  - drobek unreachable → 502, no details.
 *
 * It runs no app code and holds no state or secrets.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';

export interface AppsProxyConfig {
  /** drobek's private origin, e.g. `http://drobek.railway.internal:3000`. */
  target: URL;
  /** The apps host (`APPS_BASE_URL` without scheme), e.g. `apps-xyz.up.railway.app`. */
  appsHost: string;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Read and validate the proxy's environment; a string = the configuration error. */
export function appsProxyConfig(env: NodeJS.ProcessEnv = process.env): AppsProxyConfig | string {
  const rawTarget = (env.APPS_PROXY_TARGET ?? '').trim();
  const rawBase = (env.APPS_BASE_URL ?? '').trim();
  if (!rawTarget) return 'APPS_PROXY_TARGET is not set (drobek\'s private origin, e.g. http://drobek.railway.internal:3000)';
  if (!rawBase) return 'APPS_BASE_URL is not set (the public origin of this proxy, e.g. https://apps-xyz.up.railway.app)';
  let target: URL;
  let base: URL;
  try {
    target = new URL(rawTarget);
    base = new URL(rawBase);
  } catch {
    return 'APPS_PROXY_TARGET and APPS_BASE_URL must be absolute http(s) URLs';
  }
  for (const [name, url] of [['APPS_PROXY_TARGET', target], ['APPS_BASE_URL', base]] as const) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${name} must be an http(s) URL`;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      return `${name} must be a bare origin (no path, query or credentials)`;
    }
  }
  return { target, appsHost: base.host.toLowerCase() };
}

/** The headers sent to drobek for one incoming request. */
export function forwardedHeaders(incoming: IncomingHttpHeaders, peer: string | undefined, appsHost: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(incoming.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key) || connectionTokens.has(key)) continue;
    if (key === 'host' || key === 'x-forwarded-host' || key === 'forwarded' || key === 'x-real-ip' || key === 'x-forwarded-for') continue;
    out[key] = value;
  }
  out.host = appsHost;
  const ip = clientIp(incoming, peer);
  if (ip) {
    out['x-real-ip'] = ip;
    out['x-forwarded-for'] = ip;
  }
  return out;
}

function clientIp(headers: IncomingHttpHeaders, peer: string | undefined): string | null {
  const real = String(headers['x-real-ip'] ?? '').trim();
  if (real) return real;
  const xff = String(headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (xff.length > 0) return xff[xff.length - 1];
  return peer ?? null;
}

/** The request handler: forward to drobek, stream the answer back. */
export function createAppsProxy(config: AppsProxyConfig): (req: IncomingMessage, res: ServerResponse) => void {
  const client = config.target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  return (req, res) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/healthz' || req.url?.startsWith('/healthz?'))) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'ok');
      return;
    }
    const path = req.url && req.url.startsWith('/') ? req.url : '/';
    const upstream = client.request(
      {
        protocol: config.target.protocol,
        hostname: config.target.hostname,
        port: config.target.port || undefined,
        method: req.method,
        path,
        headers: forwardedHeaders(req.headers, req.socket.remoteAddress, config.appsHost),
        agent,
      },
      (answer) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          headers[name] = value;
        }
        res.writeHead(answer.statusCode ?? 502, headers);
        // Server-sent events: push each chunk out as it comes.
        res.flushHeaders();
        answer.pipe(res);
        answer.on('error', () => res.destroy());
      }
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Bad gateway');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}

/** Start the proxy on `port`; resolves with the server once it listens. */
export function startAppsProxy(config: AppsProxyConfig, port: number, host = '::'): Promise<http.Server> {
  const server = http.createServer(createAppsProxy(config));
  // Long-lived streams (SSE) must not be cut by the default request timeout.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
