/**
 * Security headers for served app responses (U7, PHY-58 / PHY-52). Pure.
 *
 * CSP trade-off for STATIC vibecoded apps: they routinely inline `<script>` and
 * `<style>` and load only same-origin assets, so a nonce/hash CSP would break
 * the vast majority of them. We therefore ship a conservative ALLOW-INLINE
 * policy that still confines the app to its own origin for actives and blocks
 * the dangerous primitives:
 *   default-src 'self'                  — same-origin only by default
 *   script-src 'self' 'unsafe-inline'   — inline app scripts run; no cross-origin JS
 *   style-src  'self' 'unsafe-inline'   — inline styles run
 *   img/font/media-src 'self' data: …   — data/blob assets common in SPAs
 *   connect-src 'self'                  — fetch/XHR/WebSocket back to same origin only
 *   object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'
 *
 * ⚠️ RESIDUAL RISK (PHY-98 / U11): the apex same-origin is NOT a real boundary
 * against an untrusted author. An app served here shares drobek's origin with
 * the dashboard, and neither CSP nor path-scoped cookies stop a same-origin
 * credentialed fetch from app JS to the dashboard. This is ACCEPTED for the
 * single-user self-host / M0–M1a only. The real fix — moving the dashboard to
 * app.drobek.app and giving apps a per-workspace apps-origin — is PHY-98 / U11,
 * OUT OF U7 SCOPE. Do NOT treat this CSP as an author sandbox.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ');

/** Invariant security headers on EVERY served app response (incl. 404/304). */
export function baseSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': APP_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  };
}

export interface AppHeaderInput {
  contentType: string;
  etag: string;
  cacheControl: string;
  contentLength?: number;
}

/** Full header set for a 200 (or HEAD) file response. */
export function appResponseHeaders(input: AppHeaderInput): Record<string, string> {
  const h: Record<string, string> = {
    ...baseSecurityHeaders(),
    'Content-Type': input.contentType,
    ETag: input.etag,
    'Cache-Control': input.cacheControl,
  };
  if (input.contentLength !== undefined) {
    h['Content-Length'] = String(input.contentLength);
  }
  return h;
}
