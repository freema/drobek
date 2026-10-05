// e2e-only upstream on the compose network (hostname `proxy-echo`, allow-listed
// via PROXY_ALLOWED_HOSTS): echoes requests as JSON, serves redirects the
// proxy refuses or follows, server-sent events, a slow answer, mock CIMD
// documents, a sync feed, the fake limits
// provider and the ops-probe fixture's report capture. Upstreams may only use
// ports 80/443, so it also listens on EXTRA_PORTS; the CIMD mock, the
// healthcheck and the report capture keep PORT (8099).
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
const OPS_REPORTS_MAX = 500;
const opsReports = [];
let opsJobFail = null;

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

  // A redirect to another host (the cloud-metadata endpoint) — drobek refuses it
  // as upstream_redirect and never follows it.
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end('redirecting');
    return;
  }
  // A redirect under the upstream's base and allowed prefixes (followed) …
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

  // Server-sent events for the proxy's streamed relay: /echo/sse sends 5
  // events ~400 ms apart, /echo/sse/stall one event and then nothing (until
  // the client leaves); /echo/slow?ms= answers after that long (at most 30 s).
  if (url.pathname === '/echo/sse' || url.pathname === '/echo/sse/stall') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: tick\ndata: {"n":1,"at":${Date.now()}}\n\n`);
    if (url.pathname === '/echo/sse/stall') return;
    let n = 1;
    const timer = setInterval(() => {
      n += 1;
      res.write(`event: tick\ndata: {"n":${n},"at":${Date.now()}}\n\n`);
      if (n === 5) {
        clearInterval(timer);
        res.end();
      }
    }, 400);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (url.pathname === '/echo/slow') {
    const ms = Math.min(Math.max(Number(url.searchParams.get('ms') ?? 1000) || 0, 0), 30_000);
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ slow: true, ms }));
    }, ms);
    res.on('close', () => clearTimeout(timer));
    return;
  }

  // A sports feed for the sync module. It answers only with the
  // injected bearer key (never echoed) and a User-Agent (like GitHub's API),
  // `?n=` players (at most 5: the e2e DATA_MAX_DOCS_PER_APP), and /sync/fail
  // always fails.
  if (url.pathname === '/sync/players') {
    if (!req.headers['user-agent']) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"a User-Agent is required"}');
      return;
    }
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

  // The operator-only fixture module (tests-e2e/fixtures/drobek-module-ops-probe):
  // its error reporter POSTs every report to /opsprobe/reports (GET lists them),
  // and its server job asks GET /opsprobe/job for the failure a spec armed with
  // POST /opsprobe/job `{ fail }` (answered once, then cleared).
  if (url.pathname === '/opsprobe/reports' || url.pathname === '/opsprobe/job') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      let out = { ok: true };
      if (url.pathname === '/opsprobe/reports' && req.method === 'POST') {
        opsReports.push({ received_at: new Date().toISOString(), event: body });
        if (opsReports.length > OPS_REPORTS_MAX) opsReports.splice(0, opsReports.length - OPS_REPORTS_MAX);
      } else if (url.pathname === '/opsprobe/reports') {
        out = { reports: opsReports };
      } else if (req.method === 'POST') {
        opsJobFail = typeof body?.fail === 'string' ? body.fail : null;
      } else {
        out = { fail: opsJobFail };
        opsJobFail = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
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
