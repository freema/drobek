import { directRequest } from './apps-host';

const TLS_ASK_TOKEN = process.env.TLS_ASK_TOKEN ?? 'dev-only-tls-ask-token-0123456789abcdef';

/**
 * Caddy's on-demand TLS ask, exactly as Caddy sends it: to drobek's internal
 * address (Host drobek:3000 — never the public dashboard host), straight to
 * drobek (DROBEK_URL) the way Caddy reaches it. Resolves the status (200 =
 * Caddy may obtain a certificate).
 * Not a spec file — Playwright never collects it.
 */
export async function tlsAsk(domain: string): Promise<number> {
  const path = `/api/internal/tls/ask?token=${encodeURIComponent(TLS_ASK_TOKEN)}&domain=${encodeURIComponent(domain)}`;
  return (await directRequest('drobek:3000', path)).status;
}
