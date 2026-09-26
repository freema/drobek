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
 *   media-src   'self' blob: https:                     — <video>/<audio> from the app's own
 *                                                          assets or any https URL (media runs
 *                                                          no script; NSO-358)
 *   frame-src   https://www.youtube-nocookie.com https://www.youtube.com
 *               https://player.vimeo.com https://drive.google.com
 *                                                        — the curated video embeds, plus the
 *                                                          operator's APP_FRAME_SRC_EXTRA origins
 *                                                          (NSO-358); any other iframe is blocked
 *   object-src 'none'; base-uri 'self'; form-action 'self'
 *   frame-ancestors 'none'                              — or the app's validated override;
 *                                                          plus the dashboard origin (NSO-342)
 *
 * Plus `X-Content-Type-Options: nosniff` (the Content-Type comes from the path
 * extension only), `Referrer-Policy: no-referrer` (an app URL never leaks to a
 * third party), and `X-Robots-Tag: noindex` on the preview and version hosts
 * (only the published host may be indexed).
 */

export const DEFAULT_FRAME_ANCESTORS = "'none'";

/** The embeds every app may frame (NSO-358): YouTube (privacy-enhanced and classic), Vimeo, Google Drive. */
export const DEFAULT_FRAME_SRC = 'https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://drive.google.com';

const CSP_HEAD = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https://esm.sh",
  "media-src 'self' blob: https:",
];
const CSP_TAIL = ["object-src 'none'", "base-uri 'self'"];

/**
 * The CSP for an app host with the given (already validated) frame-ancestors
 * value and frame-src list (default: the curated embeds; node.ts adds the
 * operator's APP_FRAME_SRC_EXTRA, see frameSrcFromEnv).
 */
export function appCsp(frameAncestors: string = DEFAULT_FRAME_ANCESTORS, frameSrc: string = DEFAULT_FRAME_SRC): string {
  return [...CSP_HEAD, `frame-src ${frameSrc}`, ...CSP_TAIL, `frame-ancestors ${frameAncestors}`, "form-action 'self'"].join('; ');
}

// One APP_FRAME_SRC_EXTRA entry: an https origin — a host (no wildcard, no
// path, no query) and an optional port.
const HTTPS_ORIGIN_RE =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(\d{1,5}))?$/;
const MAX_FRAME_SRC_EXTRA = 20;

/**
 * Parse APP_FRAME_SRC_EXTRA: comma- and/or space-separated `https://host[:port]`
 * origins the operator lets every app frame besides the curated embeds.
 * Anything else — http, a wildcard, a path, a scheme-only source, a quote —
 * is an error (the server refuses to start), so the value can never widen
 * frame-src to the whole web or inject another directive.
 */
export function parseFrameSrcExtra(raw: string | null | undefined): { sources: string[] } | { error: string } {
  const tokens = (raw ?? '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length > MAX_FRAME_SRC_EXTRA) return { error: `at most ${MAX_FRAME_SRC_EXTRA} origins` };
  const out: string[] = [];
  for (const token of tokens) {
    const origin = token.toLowerCase().replace(/\/$/, '');
    const m = HTTPS_ORIGIN_RE.exec(origin);
    const port = m?.[1] === undefined ? null : Number(m[1]);
    if (!m || (port !== null && (port < 1 || port > 65535))) {
      return { error: `"${token.slice(0, 80)}" is not an https origin (https://host or https://host:port, no wildcard, no path)` };
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return { sources: out };
}

/** Startup check: a set APP_FRAME_SRC_EXTRA must parse (see parseFrameSrcExtra). */
export function frameSrcConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const r = parseFrameSrcExtra(env.APP_FRAME_SRC_EXTRA);
  return 'error' in r ? `drobek refuses to start: APP_FRAME_SRC_EXTRA ${r.error}.` : null;
}

/** The frame-src list of every app host: the curated embeds + the operator's valid extras. */
export function frameSrcFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const r = parseFrameSrcExtra(env.APP_FRAME_SRC_EXTRA);
  const extra = 'sources' in r ? r.sources.filter((s) => !DEFAULT_FRAME_SRC.split(' ').includes(s)) : [];
  return [DEFAULT_FRAME_SRC, ...extra].join(' ');
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

/**
 * NSO-342: the dashboard origin (PUBLIC_APP_URL) is ALWAYS a frame ancestor,
 * next to the owner's override or instead of `'none'` — the workspace app list
 * shows each app as a small, sandboxed, non-interactive iframe thumbnail. The
 * origin must pass the same source check as an override (a bare http(s)
 * origin); anything else is ignored and the value stays as it was.
 */
export function withDashboardAncestor(
  frameAncestors: string | null | undefined,
  dashboardOrigin: string | null | undefined
): string | null {
  const own = frameAncestors ?? null;
  const dashboard = (dashboardOrigin ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(dashboard) || !SOURCE_RE.test(dashboard) || dashboard.includes('*')) return own;
  if (own === null || own === DEFAULT_FRAME_ANCESTORS) return dashboard;
  const tokens = own.split(' ');
  return tokens.includes(dashboard) ? own : [...tokens, dashboard].join(' ');
}

export interface SecurityHeaderInput {
  /** Validated frame-ancestors (parseFrameAncestors), null → 'none'. */
  frameAncestors?: string | null;
  /** The frame-src list (frameSrcFromEnv); default the curated embeds. */
  frameSrc?: string;
  /** Preview and version hosts are never indexed. */
  noindex: boolean;
}

/** The invariant security headers of EVERY app-host response (incl. 304/401/404/405). */
export function appSecurityHeaders(input: SecurityHeaderInput): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': appCsp(input.frameAncestors ?? DEFAULT_FRAME_ANCESTORS, input.frameSrc ?? DEFAULT_FRAME_SRC),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (input.noindex) h['X-Robots-Tag'] = 'noindex';
  return h;
}
