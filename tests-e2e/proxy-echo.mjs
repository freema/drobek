// PHY-59 e2e echo target — a tiny in-network HTTP server the proxy specs point an
// upstream at. It echoes the request (method/path/headers) as JSON so the test
// can PROVE the injected auth header arrived, and offers a /redirect endpoint that
// 302s to an internal address so the test can prove drobek does NOT follow it.
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
