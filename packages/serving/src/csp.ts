/**
 * Security headers of every response an app host sends (M0-06, plan §3.3).
 * Pure. Every app has its own host = its own origin, so the CSP confines the
 * app to itself (+ esm.sh for the import-mapped dependencies) and the headers
 * below go on EVERY app-host response — files, 304s, the not-published / 404
 * pages and the password page alike.
 *
 *   default-src 'self'
 *   script-src  'self' https://esm.sh 'unsafe-inline'   — the build + esm.sh deps; inline app scripts run
 *   style-src   'self' 'unsafe-inline' https:           — inline styles, CSS from CDNs
 *   img-src     'self' data: blob: https:
 *   font-src    'self' data: https:
 *   connect-src 'self' https://esm.sh                   — fetch only back to the app itself
 *                                                          (modules live at /__drobek/*, M1)
 *   object-src 'none'; base-uri 'self'; form-action 'self'
 *   frame-ancestors 'none'                              — or the app's validated override
 *
 * Plus `X-Content-Type-Options: nosniff` (the Content-Type comes from the path
 * extension only), `Referrer-Policy: no-referrer` (an app URL never leaks to a
 * third party), and `X-Robots-Tag: noindex` on the preview and version hosts
 * (only the published host may be indexed).
 */

export const DEFAULT_FRAME_ANCESTORS = "'none'";

const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https://esm.sh",
  "object-src 'none'",
  "base-uri 'self'",
];

/** The CSP for an app host with the given (already validated) frame-ancestors value. */
export function appCsp(frameAncestors: string = DEFAULT_FRAME_ANCESTORS): string {
  return [...CSP_BASE, `frame-ancestors ${frameAncestors}`, "form-action 'self'"].join('; ');
}

/** The default app CSP (no embedding). */
export const APP_CSP = appCsp();

// One CSP source expression allowed in a per-app frame-ancestors override:
// 'self', or an http(s) origin whose host may start with a `*.` wildcard.
const SOURCE_RE =
  /^(?:'self'|https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?)$/;
const MAX_SOURCES = 10;

/**
 * Validate a stored `apps.frame_ancestors` override into a CSP source list, or
 * null when it is absent or invalid (→ the caller uses `'none'`). Fail closed:
 * anything but a short list of `'self'` / http(s) origins — a `;`, a quote, a
 * path, a scheme-only source like `https:`, `*` — rejects the whole value, so a
 * stored value can never inject another CSP directive or a header.
 */
export function parseFrameAncestors(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_SOURCES) return null;
  if (tokens.length === 1 && tokens[0] === "'none'") return DEFAULT_FRAME_ANCESTORS;
  if (!tokens.every((t) => SOURCE_RE.test(t))) return null;
  return [...new Set(tokens)].join(' ');
}

export interface SecurityHeaderInput {
  /** Validated frame-ancestors (parseFrameAncestors), null → 'none'. */
  frameAncestors?: string | null;
  /** Preview and version hosts are never indexed. */
  noindex: boolean;
}

/** The invariant security headers of EVERY app-host response (incl. 304/401/404/405). */
export function appSecurityHeaders(input: SecurityHeaderInput): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': appCsp(input.frameAncestors ?? DEFAULT_FRAME_ANCESTORS),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (input.noindex) h['X-Robots-Tag'] = 'noindex';
  return h;
}
