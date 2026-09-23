// PHY-59 e2e echo target — a tiny in-network HTTP server the proxy specs point an
// upstream at. It echoes the request (method/path/headers) as JSON so the test
// can PROVE the injected auth header arrived, and offers a /redirect endpoint that
// 302s to an internal address so the test can prove drobek does NOT follow it.
//
// M0-04: it also serves mock OAuth Client ID Metadata Documents (/cimd/…) for
// tests/mcp-cimd.spec.ts; the drobek service allows exactly this origin via
// OAUTH_CIMD_DEV_ORIGINS (dev/test only).
//
// It runs as a compose service (node:22-alpine, the repo bind-mounted) on the
// drobek network, hostname `proxy-echo`. Because a Docker container resolves to a
// PRIVATE IP, the SSRF guard would block it — so the web service allow-lists this
// exact hostname via PROXY_ALLOWED_HOSTS (empty in prod → fully strict).
import http from 'node:http';

const PORT = Number(process.env.PORT || 8099);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // M0-04: mock OAuth Client ID Metadata Documents. The client_id inside is
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
