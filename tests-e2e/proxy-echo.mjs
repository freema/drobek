// e2e-only upstream on the compose network (hostname `proxy-echo`, allow-listed
// via PROXY_ALLOWED_HOSTS): echoes requests as JSON, serves a /redirect the
// proxy must not follow, mock CIMD documents, a sync feed and the fake limits
// provider. Upstreams may only use ports 80/443, so it also listens on
// EXTRA_PORTS; the CIMD mock + healthcheck keep PORT (8099).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT || 8099);
const LIMITS_SECRET = process.env.LIMITS_PROVIDER_SECRET || '';
const EXTRA_PORTS = String(process.env.EXTRA_PORTS || '')
  .split(/[,\s]+/)
  .filter((p) => /^\d+$/.test(p))
  .map(Number)
  .filter((p) => p !== PORT);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Mock OAuth Client ID Metadata Documents. The client_id inside is
  // the exact URL the document was fetched from (Host header + path):
  //   /cimd/<id>/client.json           → a valid public-client document
  //   /cimd-mismatch/<id>/client.json  → client_id names ANOTHER URL
  //   /cimd-badredirect/<id>/client.json → a non-loopback http redirect_uri
  // The redirect_uri is the loopback callback the e2e browser intercepts.
  const cimd = /^\/(cimd|cimd-mismatch|cimd-badredirect)\/[A-Za-z0-9_-]+\/client\.json$/.exec(
    url.pathname
  );
  if (cimd) {
    const self = `http://${req.headers.host}${url.pathname}`;
    const doc = {
      client_id: cimd[1] === 'cimd-mismatch' ? `http://${req.headers.host}/cimd/other/client.json` : self,
      client_name: 'drobek e2e CIMD client',
      redirect_uris:
        cimd[1] === 'cimd-badredirect'
          ? ['http://attacker.example/callback']
          : ['http://127.0.0.1:9988/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc));
    return;
  }

  // A redirect to an INTERNAL target — drobek must return this 302 verbatim and
  // NEVER auto-follow it to the cloud-metadata endpoint.
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end('redirecting');
    return;
  }
  // A RELATIVE redirect (relayed) …
  if (url.pathname === '/redirect/relative') {
    res.writeHead(302, { location: '/echo/next' });
    res.end('redirecting');
    return;
  }
  // … and a gzipped JSON answer sent despite Accept-Encoding: identity, with
  // headers that must never reach the app origin.
  if (url.pathname === '/echo/gzip') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'clear-site-data': '"*"',
      'strict-transport-security': 'max-age=63072000',
      link: '</evil.js>; rel=preload; as=script',
      'x-request-id': 'echo-req-1',
    });
    res.end(gzipSync(Buffer.from(JSON.stringify({ gzipped: true, acceptEncoding: req.headers['accept-encoding'] ?? null }))));
    return;
  }

  // A sports feed for the sync module. It answers only with the
  // injected bearer key (never echoed), `?n=` players (at most 5: the e2e
  // DATA_MAX_DOCS_PER_APP), and /sync/fail always fails.
  if (url.pathname === '/sync/players') {
    if (!/^Bearer sk-e2e-/.test(String(req.headers.authorization ?? ''))) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"no key"}');
      return;
    }
    const n = Math.min(Math.max(Number(url.searchParams.get('n') ?? 3) || 0, 0), 5);
    const players = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: ['Ada', 'Bo', 'Cy', 'Dee', 'Eli'][i], points: (i + 1) * 10 }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { players } }));
    return;
  }
  if (url.pathname === '/sync/fail') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"feed down"}');
    return;
  }

  // The fake limits provider. A signed GET /limits/<workspace_id> answers the plan the
  // e2e wrote to tests-e2e/.limits-provider/<workspace_id>.json, else `{}` (the
  // env defaults); a bad signature is a 401.
  const limits = /^\/limits\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (limits && req.method === 'GET') {
    const ts = String(req.headers['x-drobek-timestamp'] ?? '');
    const want = `v1=${createHmac('sha256', LIMITS_SECRET).update(`${ts}.GET.${url.pathname}`).digest('hex')}`;
    if (!LIMITS_SECRET || req.headers['x-drobek-signature'] !== want) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"bad signature"}');
      return;
    }
    let plan = {};
    try {
      plan = JSON.parse(readFileSync(new URL(`./.limits-provider/${limits[1]}.json`, import.meta.url), 'utf8'));
    } catch {
      // no plan for this workspace: the env defaults
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ limits: plan }));
    return;
  }

  // Drain the body then echo the request back as JSON.
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
    );
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`proxy-echo listening on :${PORT}`);
});
for (const port of EXTRA_PORTS) {
  // The same handler on another port (a second listener of one server is not allowed).
  http.createServer((req, res) => server.emit('request', req, res)).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`proxy-echo also listening on :${port}`);
  });
}
