/**
 * Security headers of every response an app host sends.
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
 *                                                          (modules live at /__drobek/*)
 *   media-src   'self' blob: https:                     — <video>/<audio> from the app's own
 *                                                          assets or any https URL (media runs
 *                                                          no script)
 *   frame-src   https://www.youtube-nocookie.com https://www.youtube.com
 *               https://player.vimeo.com https://drive.google.com
 *                                                        — the curated video embeds, plus the
 *                                                          operator's APP_FRAME_SRC_EXTRA origins;
 *                                                          any other iframe is blocked
 *   object-src 'none'; base-uri 'self'; form-action 'self'
 *   frame-ancestors 'none'                              — or the app's validated override;
 *                                                          plus the dashboard origin;
 *                                                          plus GALLERY_FRAME_ANCESTORS on the
 *                                                          production host of an app shown in
 *                                                          the public gallery
 *
 * Plus `X-Content-Type-Options: nosniff` (the Content-Type comes from the path
 * extension only), `Referrer-Policy: no-referrer` (an app URL never leaks to a
 * third party), and `X-Robots-Tag: noindex` on the preview and version hosts
 * (only the published host may be indexed).
 */

import { appCspFetchDirectives } from '@drobek/compile';

export const DEFAULT_FRAME_ANCESTORS = "'none'";

/** The embeds every app may frame: YouTube (privacy-enhanced and classic), Vimeo, Google Drive. */
export const DEFAULT_FRAME_SRC = 'https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://drive.google.com';

// The fetch directives come from @drobek/compile, whose reference check warns
// about URLs this policy blocks.
const CSP_HEAD = appCspFetchDirectives();
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
 * One extra frame ancestor as a CSP source: a bare http(s) origin (no
 * wildcard, no path, no quote; a trailing slash is dropped), lowercased — or
 * null when the value is anything else.
 */
function ancestorOrigin(raw: string | null | undefined): string | null {
  const origin = (raw ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin) || !SOURCE_RE.test(origin) || origin.includes('*')) return null;
  const port = /:(\d+)$/.exec(origin)?.[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535) ? origin : null;
}

/**
 * Add origins to a validated frame-ancestors value (parseFrameAncestors):
 * each one next to the owner's override, or instead of `'none'`. Used for the
 * dashboard origin (the app-list thumbnail — every app host) and the
 * operator's gallery origins (GALLERY_FRAME_ANCESTORS — the production host of
 * an app shown in the public gallery). An origin that is not a bare http(s)
 * origin (ancestorOrigin) is ignored; no origin to add → the value as it was.
 */
export function withFrameAncestors(
  frameAncestors: string | null | undefined,
  origins: readonly (string | null | undefined)[]
): string | null {
  let tokens = frameAncestors && frameAncestors !== DEFAULT_FRAME_ANCESTORS ? frameAncestors.split(' ') : [];
  let added = false;
  for (const raw of origins) {
    const origin = ancestorOrigin(raw);
    if (origin === null) continue;
    added = true;
    if (!tokens.includes(origin)) tokens = [...tokens, origin];
  }
  return added ? tokens.join(' ') : (frameAncestors ?? null);
}

const MAX_GALLERY_ANCESTORS = 10;

/**
 * Parse GALLERY_FRAME_ANCESTORS: space-separated bare http(s) origins (the
 * operator's gallery website, e.g. `https://www.example.com`) that may frame
 * the production host of an app shown in the public gallery. Anything else —
 * a wildcard, a path, a scheme-only source, `'self'`, a quote — is an error
 * (the server refuses to start). Unset or empty = no gallery embedding.
 */
export function parseGalleryFrameAncestors(raw: string | null | undefined): { origins: string[] } | { error: string } {
  const tokens = (raw ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length > MAX_GALLERY_ANCESTORS) return { error: `at most ${MAX_GALLERY_ANCESTORS} origins` };
  const out: string[] = [];
  for (const token of tokens) {
    const origin = ancestorOrigin(token);
    if (origin === null) {
      return { error: `"${token.slice(0, 80)}" is not a bare http(s) origin (https://host or https://host:port, no wildcard, no path)` };
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return { origins: out };
}

/** Startup check: a set GALLERY_FRAME_ANCESTORS must parse (see parseGalleryFrameAncestors). */
export function galleryFrameAncestorsConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  const r = parseGalleryFrameAncestors(env.GALLERY_FRAME_ANCESTORS);
  return 'error' in r ? `drobek refuses to start: GALLERY_FRAME_ANCESTORS ${r.error}.` : null;
}

/** The valid GALLERY_FRAME_ANCESTORS origins ([] when unset or invalid). */
export function galleryFrameAncestorsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const r = parseGalleryFrameAncestors(env.GALLERY_FRAME_ANCESTORS);
  return 'origins' in r ? r.origins : [];
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
