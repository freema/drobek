import { request as httpRequest } from 'node:http';
import { BASE_URL_WEB } from '../../playwright.config';

const TLS_ASK_TOKEN = process.env.TLS_ASK_TOKEN ?? 'dev-only-tls-ask-token-0123456789abcdef';

/**
 * Caddy's on-demand TLS ask, exactly as Caddy sends it: to drobek's internal
 * address (Host drobek:3000 — never the public dashboard host). The dev stack
 * publishes that port as the dashboard's host port, so connect there with an
 * explicit Host. Resolves the status (200 = Caddy may obtain a certificate).
 * Not a spec file — Playwright never collects it.
 */
export function tlsAsk(domain: string): Promise<number> {
  const web = new URL(BASE_URL_WEB);
  const port = Number(web.port || (web.protocol === 'https:' ? 443 : 80));
  const path = `/api/internal/tls/ask?token=${encodeURIComponent(TLS_ASK_TOKEN)}&domain=${encodeURIComponent(domain)}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'drobek:3000' }, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: tls ask ${domain}`)));
    req.on('error', reject);
    req.end();
  });
}
