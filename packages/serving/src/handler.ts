/**
 * The app-host request handler (M0-06): one request on `<slug>[--preview|--v<N>]
 * .<APPS_DOMAIN>` → one response. Framework-free: a plain request description
 * in, a plain response out; `node.ts` adapts it to node:http / Express.
 *
 * Order (each step before any byte of the app is touched):
 *   1. method — GET/HEAD, plus POST to the password-unlock path; else 405;
 *   2. the app behind the host (404 page when there is none; NSO-315: a client
 *      IP past its unknown-host budget gets 429 instead — and, while throttled,
 *      429 before any lookup for hosts the cache does not know as live apps);
 *   3. the visibility gate (password page / unlock POST);
 *   4. the version the host serves (404 "not published" / "nothing compiled");
 *   5. the file: built wins over source, TS/JSX sources never served, SPA
 *      fallback for extension-less paths, ETag = sha256 → 304;
 *   6. no such file and the path can name an asset (`/film.mp4`,
 *      `/img/s1.jpg`): the app's uploaded asset (NSO-358, `deps.assets` —
 *      video/audio/images/fonts, Range 206, see assets.ts). Assets are per
 *      app, so every host that serves a version serves them; the version's
 *      own file at the same path wins. Asset paths always carry a media
 *      extension, so the SPA fallback never answers for one.
 *
 * BEACON (M1-07): `POST /__drobek/v1/_beacon` goes to `deps.beacon` (core, not
 * a module — every app reports its browser errors without configuration),
 * after steps 2 and 3 like a platform path; it is not counted as a request.
 *
 * PLATFORM paths (M1-01): `/__drobek/*` (except the unlock POST) go to
 * `deps.platform` — the module runtime (SDK, module routes) — AFTER steps 2
 * and 3, so a module route never runs for a missing app or behind a locked
 * password gate (that answers JSON 401 `password_required`). Any method may reach
 * it; the runtime answers 405 itself. The app's files are never involved.
 *
 * CUSTOM DOMAINS (M3-01): a verified custom domain arrives as target
 * `custom` and is served exactly like the production host (published
 * version, indexable). When the app has a PRIMARY domain, its production host
 * answers a GET/HEAD page request with 302 → the same path on that domain
 * (after step 2; platform, beacon and unlock requests are never redirected).
 *
 * ISOLATION: this handler reads exactly ONE cookie, the app-access cookie of
 * the password gate, and sets no other; the platform handler additionally
 * reads the app's end-user cookie (`drobek_eu`, M1-01). The dashboard session
 * is never parsed, looked up or touched here, whatever the request carries.
 * Every response — 200, 304, 401, 404, 405, 429, 500 — carries the app CSP,
 * nosniff, Referrer-Policy and (preview/version hosts) X-Robots-Tag; a module
 * response may add a stricter CSP of its own as a second policy (NSO-325).
 *
 * ABUSE (M4-02, NSO-293): `GET /.well-known/drobek-report` on ANY app host
 * answers `{ report_url, app, terms_url }` (public, cacheable 1 h) before
 * anything else — where to report this host. A taken-down app
 * (`lockedReason`) answers 451 on every host (prod, preview, version,
 * custom domain) and every path right after step 2 — before the
 * primary-domain redirect, the password gate, the platform and the beacon
 * (JSON `app_locked_by_admin` there). Once the app resolved,
 * every response carries `X-Drobek-App: <slug>` (tracing a report to an app).
 */
import type { Readable } from 'node:stream';
import {
  REPORT_WELL_KNOWN_PATH,
  lockCategory,
  reasonLabel,
  reportFormUrl,
  termsUrl,
  type AppHostTarget,
} from '@drobek/apps';
import { assetNameOf, assetResponsePlan, type AssetSource } from './assets.js';
import { contentTypeForPath } from './content-type.js';
import { appSecurityHeaders, parseFrameAncestors, withDashboardAncestor } from './csp.js';
import { UNLOCK_PATH, errorPage, lockedPage, missingPage, passwordPage, type MissingReason } from './pages.js';
import {
  appAccessCookieName,
  appAccessCookieHeader,
  mintAppAccessToken,
  verifyAppAccessToken,
  verifyAppPassword,
} from './password.js';
import {
  cacheControlFor,
  decodeRequestPath,
  etagFor,
  isNotModified,
  resolveServePath,
} from './resolve.js';
import type { ServeApp, ServeStore } from './store.server.js';
import type { UnknownHostLimiter } from './unknown-host.js';
import { decideVisibility } from './visibility.js';

export interface AppRequest {
  method: string;
  /** The parsed host; null = a host under APPS_DOMAIN that names no app host. */
  target: AppHostTarget | null;
  /** Raw request path (percent-encoded, no query). */
  path: string;
  /** Raw query string without the `?` ('' when none). */
  query: string;
  header(name: string): string | null;
  /** Every request header, lower-cased names (platform paths: the proxy module forwards them, filtered). */
  headers?(): Record<string, string>;
  /** The urlencoded form body (unlock POST only; capped by the adapter). null when unreadable. */
  readForm(): Promise<URLSearchParams | null>;
  /** The raw body up to `limit` bytes ('too_large' past it; platform paths only). */
  readBody(limit: number): Promise<Buffer | 'too_large' | null>;
  /**
   * The raw body as a stream, UNCAPPED (platform file uploads — the module
   * route caps it). `return()` abandons the rest: it is discarded, never
   * buffered. Once per request.
   */
  bodyStream?(): AsyncIterableIterator<Buffer>;
  clientIp: string | null;
}

/** Where the platform (module runtime) answers on every app host. */
export const PLATFORM_PREFIX = '/__drobek/';

/** The browser error beacon on every app host (M1-07; handled by core, not a module). */
export const BEACON_PATH = '/__drobek/v1/_beacon';

/** Answers the beacon POST for a resolved, visibility-cleared app. */
export type BeaconHandler = (req: AppRequest, app: ServeApp) => Promise<AppResponse>;

/** Answers a `/__drobek/*` request for a resolved, visibility-cleared app. */
export type PlatformHandler = (req: AppRequest, ctx: { app: ServeApp; target: AppHostTarget }) => Promise<AppResponse>;

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  /** A Readable (a platform file download) is piped by the adapter. */
  body: Buffer | string | Readable | null;
}

export interface HandlerDeps {
  store: ServeStore;
  /** App-access signing key (appAccessSecret); null → password apps stay locked. */
  accessSecret: string | null;
  /** Fixed-window limiter for unlock attempts (true = allowed). */
  allowUnlockAttempt(appId: string, clientIp: string | null): Promise<boolean>;
  /** Best-effort, fire-and-forget request/404/5xx counters. */
  signal?(appId: string, kind: 'request' | '404' | '5xx', path?: string): void;
  now?: () => number;
  /** `__Host-` + Secure app-access cookie (default true; false only on plain-http dev). */
  secureCookies?: boolean;
  /** The module runtime for `/__drobek/*` (absent → those paths are plain 404s). */
  platform?: PlatformHandler;
  /** The browser error beacon at BEACON_PATH (absent → the path falls to `platform`). */
  beacon?: BeaconHandler;
  /**
   * M3-01: the origin of a custom domain, for the primary-domain redirect
   * (default `https://<hostname>`; node.ts derives scheme + port from the apps origin).
   */
  customDomainOrigin?: (hostname: string) => string;
  /** `host → report form URL` for the well-known report pointer (default: `<PUBLIC_APP_URL>/report?host=`). */
  reportUrl?: (host: string) => string;
  /** The terms the 451 page links (default: TERMS_URL, else `<PUBLIC_APP_URL>/terms`). */
  termsUrl?: string;
  /** NSO-315: per-IP budget of "no app here" answers (absent → never throttled). */
  unknownHosts?: UnknownHostLimiter;
  /**
   * NSO-342: the dashboard origin (PUBLIC_APP_URL), always allowed in
   * `frame-ancestors` so the workspace app list can show a sandboxed,
   * non-interactive thumbnail of the app (absent → only the app's own setting).
   */
  dashboardOrigin?: string | null;
  /** NSO-358: the frame-src list of every app host (frameSrcFromEnv; absent → the curated embeds). */
  frameSrc?: string;
  /** NSO-358: the app's uploaded assets at `/<name>` (absent → only the version's files are served). */
  assets?: AssetSource;
}

/** Header naming the app behind an app-host response (M4-02). */
export const APP_HEADER = 'X-Drobek-App';

const HTML = 'text/html; charset=utf-8';
const NO_STORE = 'no-store';

/** Unlock attempts per app + client IP per window (see node.ts for the window). */
export const UNLOCK_ATTEMPTS = 10;
/**
 * Unlock attempts per app over ALL clients per window — the per-password cap
 * that also holds for a request without a resolved client IP, which has no
 * per-IP bucket (NSO-328).
 */
export const UNLOCK_APP_ATTEMPTS = 100;
export const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_CHARS = 1024;

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** A same-host relative path to return to after unlocking (never `//host` or a URL). */
function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 2000 || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/';
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return '/';
  }
  return raw;
}

export async function handleAppRequest(req: AppRequest, deps: HandlerDeps): Promise<AppResponse> {
  const method = req.method.toUpperCase();
  const kind = req.target?.kind;
  const noindex = kind !== 'prod' && kind !== 'custom';
  let security = appSecurityHeaders({ noindex, frameSrc: deps.frameSrc });

  const page = (status: number, html: string, extra: Record<string, string> = {}): AppResponse => ({
    status,
    headers: { ...security, 'Content-Type': HTML, 'Cache-Control': NO_STORE, ...extra },
    body: method === 'HEAD' ? null : html,
  });
  const missing = (reason: MissingReason) => page(404, missingPage(reason));

  const isUnlock = method === 'POST' && req.path === UNLOCK_PATH;
  const isBeacon = deps.beacon !== undefined && req.path === BEACON_PATH;
  const isPlatform = !isUnlock && !isBeacon && deps.platform !== undefined && req.path.startsWith(PLATFORM_PREFIX);
  if (method !== 'GET' && method !== 'HEAD' && !isUnlock && !isPlatform && !isBeacon) {
    return page(405, errorPage('Method not allowed', 'This address only serves files.'), {
      Allow: 'GET, HEAD',
    });
  }

  // ── where to report this host (M4-02) — any app host, before anything else ──
  if ((method === 'GET' || method === 'HEAD') && req.path === REPORT_WELL_KNOWN_PATH) {
    return wellKnownReport(req, deps, method, security);
  }

  // ── the app (NSO-315: unknown hosts are counted per client IP) ──
  const throttled = (): AppResponse => ({
    status: 429,
    headers: {
      ...security,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': NO_STORE,
      'Retry-After': String(deps.unknownHosts?.retryAfterSec ?? 60),
    },
    body: method === 'HEAD' ? null : 'Too Many Requests',
  });
  const unknownApp = async (): Promise<AppResponse> =>
    deps.unknownHosts && !(await deps.unknownHosts.allow(req.clientIp)) ? throttled() : missing('no-app');

  if (!req.target) return unknownApp();
  if (deps.unknownHosts?.isThrottled(req.clientIp) && !deps.store.knowsLiveApp(req.target.slug)) {
    return throttled();
  }
  const { app, version } = await deps.store.resolve(req.target);
  if (!app) return unknownApp();
  security = {
    ...appSecurityHeaders({
      noindex,
      frameSrc: deps.frameSrc,
      frameAncestors: withDashboardAncestor(parseFrameAncestors(app.frameAncestors), deps.dashboardOrigin),
    }),
    [APP_HEADER]: app.slug,
  };
  if (!isBeacon) deps.signal?.(app.id, 'request');

  // ── taken down by a super-admin (M4-02): 451 on every host and path ──
  if (app.lockedReason) {
    const category = lockCategory(app.lockedReason);
    const terms = deps.termsUrl ?? termsUrl();
    if (isPlatform || isBeacon) {
      return {
        status: 451,
        headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
        body: JSON.stringify({
          error: 'app_locked_by_admin',
          message: 'This app was taken down by the server operator.',
          details: { reason: category },
        }),
      };
    }
    return page(451, lockedPage({ reasonLabel: reasonLabel(category), termsUrl: terms }), {
      Link: `<${terms}>; rel="blocked-by"`,
    });
  }

  // ── primary custom domain: the production host redirects there (M3-01) ──
  if (
    req.target.kind === 'prod' &&
    app.primaryDomain &&
    (method === 'GET' || method === 'HEAD') &&
    !req.path.startsWith(PLATFORM_PREFIX)
  ) {
    const origin = deps.customDomainOrigin?.(app.primaryDomain) ?? `https://${app.primaryDomain}`;
    const location = `${origin}${req.path}${req.query ? `?${req.query}` : ''}`;
    return { status: 302, headers: { ...security, Location: location, 'Cache-Control': NO_STORE }, body: null };
  }

  // ── visibility gate ──
  if (isUnlock) return unlock(req, app, deps, page);
  const token = readCookie(req.header('cookie'), appAccessCookieName(deps.secureCookies ?? true));
  const hasAppAccess =
    app.visibility === 'password' && token !== null && deps.accessSecret !== null
      ? verifyAppAccessToken(token, app.id, deps.accessSecret, (deps.now ?? Date.now)())
      : false;
  const locked = decideVisibility({ visibility: app.visibility, hasAppAccess }).action === 'password';
  if (isPlatform || isBeacon) {
    if (locked) {
      return {
        status: 401,
        headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
        body: JSON.stringify({ error: 'password_required', message: 'This app is password-protected — unlock it first.' }),
      };
    }
    if (isBeacon) {
      const b = await deps.beacon!(req, app);
      return { ...b, headers: { ...b.headers, ...security } };
    }
    const r = await deps.platform!(req, { app, target: req.target });
    if (r.status >= 500) deps.signal?.(app.id, '5xx');
    return { ...r, headers: withAppSecurity(r.headers, security) };
  }
  if (locked) {
    const next = safeNext(req.query ? `${req.path}?${req.query}` : req.path);
    return page(401, passwordPage({ next }));
  }

  // ── the version this host serves ──
  if (!version) {
    const k = req.target.kind;
    return missing(k === 'prod' || k === 'custom' ? 'not-published' : k === 'preview' ? 'nothing-compiled' : 'no-version');
  }

  // ── the file ──
  const decoded = decodeRequestPath(req.path);
  if (decoded === null) return missing('no-file');
  let manifest;
  try {
    manifest = await deps.store.manifest(version.id);
  } catch (err) {
    deps.signal?.(app.id, '5xx');
    throw err;
  }
  const hit = resolveServePath({ requestPath: decoded, routingMode: 'spa', has: (p) => manifest.has(p) });
  const entry = hit.kind === 'file' ? manifest.get(hit.path) : undefined;
  if (hit.kind !== 'file' || !entry) {
    const assetName = deps.assets ? assetNameOf(decoded) : null;
    if (assetName !== null) {
      const served = await serveAsset(req, deps.assets!, { app, name: assetName, security, published: !noindex });
      if (served) return served;
    }
    deps.signal?.(app.id, '404', req.path);
    return missing('no-file');
  }

  const etag = etagFor(entry.sha256);
  const headers: Record<string, string> = {
    ...security,
    'Content-Type': contentTypeForPath(hit.path),
    ETag: etag,
    'Cache-Control': cacheControlFor({
      path: hit.path,
      query: req.query,
      isPrivate: app.visibility !== 'public',
    }),
  };
  if (isNotModified(req.header('if-none-match'), etag)) {
    return { status: 304, headers, body: null };
  }
  const bytes = await deps.store.blob(entry.sha256);
  if (!bytes) {
    // metadata without bytes — fail closed
    deps.signal?.(app.id, '5xx');
    return missing('no-file');
  }
  headers['Content-Length'] = String(bytes.length);
  return { status: 200, headers, body: method === 'HEAD' ? null : bytes };
}

/** An uploaded asset of the app (NSO-358), or null when the app has none by that name. */
async function serveAsset(
  req: AppRequest,
  assets: AssetSource,
  input: { app: ServeApp; name: string; security: Record<string, string>; published: boolean }
): Promise<AppResponse | null> {
  const asset = await assets.find(input.app.id, input.name);
  if (!asset) return null;
  const plan = assetResponsePlan({
    method: req.method,
    header: (n) => req.header(n),
    asset,
    published: input.published,
    isPrivate: input.app.visibility !== 'public',
  });
  const headers = withAppSecurity(plan.headers, input.security);
  if (!plan.send) return { status: plan.status, headers, body: null };
  const body = await assets.open(input.app.id, asset.storageKey, plan.range ?? undefined);
  return body ? { status: plan.status, headers, body } : null;
}

const CSP_HEADER = 'Content-Security-Policy';

/**
 * A module response under the app's security headers. The app's headers win
 * (a module can never loosen them) — except that a module's own
 * `Content-Security-Policy` is kept as a SECOND policy next to the app CSP
 * (`<app csp>, <module csp>`: a browser enforces every policy of the list, so
 * a module can only tighten it — e.g. the files module's `sandbox` on served
 * files, NSO-325).
 */
function withAppSecurity(headers: Record<string, string>, security: Record<string, string>): Record<string, string> {
  let moduleCsp: string | null = null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === CSP_HEADER.toLowerCase()) moduleCsp = v.trim() || null;
    else out[k] = v;
  }
  Object.assign(out, security);
  const appPolicy = security[CSP_HEADER];
  if (moduleCsp) out[CSP_HEADER] = appPolicy ? `${appPolicy}, ${moduleCsp}` : moduleCsp;
  return out;
}

async function unlock(
  req: AppRequest,
  app: ServeApp,
  deps: HandlerDeps,
  page: (status: number, html: string, extra?: Record<string, string>) => AppResponse
): Promise<AppResponse> {
  const form = await req.readForm();
  const next = safeNext(form?.get('next'));
  const redirect = (setCookie?: string): AppResponse =>
    page(303, '', { Location: next, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });

  if (app.visibility !== 'password') return redirect();
  if (!deps.accessSecret) {
    return page(500, errorPage('Unavailable', 'This app cannot be unlocked right now.'));
  }
  if (!(await deps.allowUnlockAttempt(app.id, req.clientIp))) {
    return page(429, passwordPage({ next, error: 'rate_limited' }), { 'Retry-After': String(UNLOCK_WINDOW_MS / 1000) });
  }
  const password = form?.get('password') ?? '';
  const ok =
    password.length > 0 &&
    password.length <= MAX_PASSWORD_CHARS &&
    (await verifyAppPassword(password, await deps.store.passwordHash(app.id)));
  if (!ok) return page(401, passwordPage({ next, error: 'wrong' }));
  const token = mintAppAccessToken(app.id, deps.accessSecret, undefined, (deps.now ?? Date.now)());
  return redirect(appAccessCookieHeader(token, { secure: deps.secureCookies ?? true }));
}

/** `GET /.well-known/drobek-report` — the report form for this host (public, 1 h cacheable). */
async function wellKnownReport(
  req: AppRequest,
  deps: HandlerDeps,
  method: string,
  security: Record<string, string>
): Promise<AppResponse> {
  const host = (req.header('host') ?? '').trim().toLowerCase().replace(/\.+(?=:|$)/, '');
  const app = req.target ? (await deps.store.resolve(req.target)).app : null;
  const body = JSON.stringify({
    report_url: (deps.reportUrl ?? ((h: string) => reportFormUrl(h)))(host),
    app: app?.slug ?? null,
    terms_url: deps.termsUrl ?? termsUrl(),
  });
  return {
    status: 200,
    headers: {
      ...security,
      ...(app ? { [APP_HEADER]: app.slug } : {}),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
    body: method === 'HEAD' ? null : body,
  };
}
