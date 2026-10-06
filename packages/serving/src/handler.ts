/**
 * The app-host request handler: one request on `<slug>[--preview|--v<N>]
 * .<APPS_DOMAIN>` → one response. Framework-free: a plain request description
 * in, a plain response out; `node.ts` adapts it to node:http / Express.
 *
 * Order (each step before any byte of the app is touched):
 *   1. method — GET/HEAD, plus POST to the password-unlock path; else 405;
 *   2. the app behind the host (404 page when there is none; a client
 *      IP past its unknown-host budget gets 429 instead — and, while throttled,
 *      429 before any lookup for hosts the cache does not know as live apps).
 *      A version host whose version does not exist or did not compile is
 *      counted against the same budget (429 past it; else its 404 at step 4);
 *   3. the visibility gate (password page / unlock POST);
 *   4. the version the host serves (404 "not published" / "nothing compiled");
 *   5. the file: built wins over source, TS/JSX sources never served, SPA
 *      fallback for extension-less paths, ETag = sha256 → 304. On
 *      the production host and custom domains a built JS/CSS bundle is served
 *      without its inline source map (ETag `"<sha256>-nomap"`), pointing at
 *      `<file>.map`, which serves that map; the preview and version hosts
 *      serve the bundle exactly as stored (see sourcemap.ts);
 *   6. no such file and the path can name an asset (`/film.mp4`,
 *      `/img/s1.jpg`): the app's uploaded asset (`deps.assets` —
 *      video/audio/images/fonts, Range 206, see assets.ts). The
 *      production host and custom domains serve the set the publish froze,
 *      the preview host the draft, a version host that version's set (or
 *      the draft) — `assetScopeFor`. The version's own file at the same path
 *      wins. Asset paths always carry a media extension, so the SPA fallback
 *      never answers for one.
 *
 * BEACON: `POST /__drobek/v1/_beacon` goes to `deps.beacon` (core, not
 * a module — every app reports its browser errors and page loads without
 * configuration), after steps 2 and 3 like a platform path, with the version
 * the host serves now; it is not counted as a request. Every HTML file
 * response names the version it was served from in `Server-Timing:
 * drobek-version;desc="<N>"`, which the beacon reads from the page's
 * navigation timing and sends along, so a report is filed under the version
 * of its page even after the host moved on.
 *
 * PLATFORM paths: `/__drobek/*` (except the unlock POST) go to
 * `deps.platform` — the module runtime (SDK, module routes) — AFTER steps 2
 * and 3, so a module route never runs for a missing app or behind a locked
 * password gate (that answers JSON 401 `password_required`) — except a route
 * that authenticates the caller itself (`deps.platformSkipsGate`, a signed
 * webhook). Any method may reach
 * it; the runtime answers 405 itself. The app's files are never involved.
 *
 * CUSTOM DOMAINS: a verified custom domain arrives as target
 * `custom` and is served exactly like the production host (published
 * version, indexable). When the app has a PRIMARY domain, its production host
 * answers a GET/HEAD page request with 302 → the same path on that domain
 * (after step 2; platform, beacon and unlock requests are never redirected).
 *
 * ISOLATION: this handler reads exactly ONE cookie, the app-access cookie of
 * the password gate, and sets no other; the platform handler additionally
 * reads the app's end-user cookie (`drobek_eu`). The dashboard session
 * is never parsed, looked up or touched here, whatever the request carries.
 * Every response — 200, 304, 401, 404, 405, 429, 500 — carries the app CSP,
 * nosniff, Referrer-Policy and (preview/version hosts) X-Robots-Tag; a module
 * response may add a stricter CSP of its own as a second policy.
 *
 * GALLERY EMBEDDING: the operator's GALLERY_FRAME_ANCESTORS origins join
 * `frame-ancestors` (next to the dashboard origin and the owner's override)
 * only on the production host and custom domains of an app the public gallery
 * shows right now (`ServeApp.galleryVisible`, cached like the rest of the app
 * row) — never on its preview or version hosts.
 *
 * FEEDBACK: with `deps.feedback`, every HTML file the preview and version
 * hosts serve carries the feedback widget's script tag before `</body>` (its
 * ETag says so: `"<sha256>-fb<N>-<widget hash>"`), unless the version's
 * drobek.json says `"feedback": false`; `GET /__drobek/feedback.js` serves the
 * widget there, after steps 2 and 3, and is not counted as a request. The
 * production host and custom domains never carry or serve it (see
 * feedback-widget.ts).
 *
 * ABUSE: `GET /.well-known/drobek-report` on ANY app host
 * answers `{ report_url, app, terms_url }` (public, cacheable 1 h) before
 * anything else — where to report this host. A taken-down app
 * (`lockedReason`) answers 451 on every host (prod, preview, version,
 * custom domain) and every path right after step 2 — before the
 * primary-domain redirect, the password gate, the platform and the beacon
 * (JSON `app_locked_by_admin` there). Once the app resolved,
 * every response carries `X-Drobek-App: <slug>` (tracing a report to an app).
 */
import type { Readable } from 'node:stream';
import { readCookieValue } from '@drobek/core';
import type { PageViewInput } from '@drobek/insights';
import {
  REPORT_WELL_KNOWN_PATH,
  lockCategory,
  reasonLabel,
  reportFormUrl,
  termsUrl,
  type AppHostTarget,
  type AssetScope,
} from '@drobek/apps';
import { assetNameOf, assetResponsePlan, type AssetSource } from './assets.js';
import { contentTypeForPath } from './content-type.js';
import { FEEDBACK_SCRIPT_PATH, feedbackScriptTag, injectBeforeBodyEnd, type FeedbackWidget } from './feedback-widget.js';
import { appSecurityHeaders, parseFrameAncestors, withFrameAncestors } from './csp.js';
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
  normalizeRequestPath,
  resolveServePath,
} from './resolve.js';
import { mayCarryInlineSourceMap } from './sourcemap.js';
import type { ServedManifest } from './manifest.js';
import type { ServeApp, ServeStore, ServeVersion } from './store.server.js';
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

/** The browser error beacon on every app host (handled by core, not a module). */
export const BEACON_PATH = '/__drobek/v1/_beacon';

/** Answers the beacon POST for a resolved, visibility-cleared app; `version` = what the host serves now (null = nothing). */
export type BeaconHandler = (req: AppRequest, app: ServeApp, version: ServeVersion | null) => Promise<AppResponse>;

/** The `Server-Timing` metric that names the version an HTML page was served from (read by the beacon). */
export const VERSION_TIMING_METRIC = 'drobek-version';

/** Answers a `/__drobek/*` request for a resolved, visibility-cleared app. */
export type PlatformHandler = (req: AppRequest, ctx: { app: ServeApp; target: AppHostTarget }) => Promise<AppResponse>;

export interface AppResponse {
  status: number;
  headers: Record<string, string | string[]>;
  /** A Readable (a platform file download) is piped by the adapter. */
  body: Buffer | string | Readable | null;
}

export interface HandlerDeps {
  store: ServeStore;
  /** App-access signing key (appAccessSecret); null → password apps stay locked. */
  accessSecret: string | null;
  /** Fixed-window limiter for unlock attempts (true = allowed). */
  allowUnlockAttempt(appId: string, clientIp: string | null): Promise<boolean>;
  /** Best-effort, fire-and-forget request/404/5xx counters; `4xx` (a platform 4xx) and a 5xx with `path` record the failing path. */
  signal?(appId: string, kind: 'request' | '404' | '4xx' | '5xx', path?: string): void;
  /**
   * Best-effort, fire-and-forget page-view counter (app traffic analytics):
   * called for a successful (200 / 304) GET of an HTML document on the
   * production host or a custom domain only (absent → nothing is counted).
   */
  pageView?(appId: string, view: PageViewInput): void;
  now?: () => number;
  /** `__Host-` + Secure app-access cookie (default true; false only on plain-http dev). */
  secureCookies?: boolean;
  /** The module runtime for `/__drobek/*` (absent → those paths are plain 404s). */
  platform?: PlatformHandler;
  /**
   * Whether a platform request goes to a module route that authenticates the
   * caller itself (`passwordGate: 'skip'`, e.g. a signed webhook): the
   * password gate lets it through (absent → every platform path is gated).
   */
  platformSkipsGate?(method: string, path: string): boolean;
  /** The browser error beacon at BEACON_PATH (absent → the path falls to `platform`). */
  beacon?: BeaconHandler;
  /**
   * The origin of a custom domain, for the primary-domain redirect
   * (default `https://<hostname>`; node.ts derives scheme + port from the apps origin).
   */
  customDomainOrigin?: (hostname: string) => string;
  /** `host → report form URL` for the well-known report pointer (default: `<PUBLIC_APP_URL>/report?host=`). */
  reportUrl?: (host: string) => string;
  /** The terms the 451 page links (default: TERMS_URL, else `<PUBLIC_APP_URL>/terms`). */
  termsUrl?: string;
  /** Per-IP budget of "no app here" answers (absent → never throttled). */
  unknownHosts?: UnknownHostLimiter;
  /**
   * The dashboard origin (PUBLIC_APP_URL), always allowed in
   * `frame-ancestors` so the workspace app list can show a sandboxed,
   * non-interactive thumbnail of the app (absent → only the app's own setting).
   */
  dashboardOrigin?: string | null;
  /**
   * GALLERY_FRAME_ANCESTORS (only while GALLERY_ENABLED): the operator's
   * gallery origins, allowed in `frame-ancestors` of the production host and
   * custom domains of an app the public gallery shows (`galleryVisible`), so
   * the gallery can show a live, sandboxed preview. Preview and version hosts
   * never get them (absent → no gallery embedding).
   */
  galleryFrameAncestors?: readonly string[];
  /** The frame-src list of every app host (frameSrcFromEnv; absent → the curated embeds). */
  frameSrc?: string;
  /** The app's uploaded assets at `/<name>` (absent → only the version's files are served). */
  assets?: AssetSource;
  /** The feedback widget of the preview and version hosts (absent → no widget). */
  feedback?: FeedbackWidget | null;
}

/** Header naming the app behind an app-host response. */
export const APP_HEADER = 'X-Drobek-App';

const HTML = 'text/html; charset=utf-8';
const NO_STORE = 'no-store';

/** Unlock attempts per app + client IP per window (see node.ts for the window). */
export const UNLOCK_ATTEMPTS = 10;
/**
 * Unlock attempts per app over ALL clients per window — the per-password cap
 * that also holds for a request without a resolved client IP, which has no
 * per-IP bucket.
 */
export const UNLOCK_APP_ATTEMPTS = 100;
export const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_PASSWORD_CHARS = 1024;

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
  const production = kind === 'prod' || kind === 'custom';
  const noindex = !production;
  let security = appSecurityHeaders({ noindex, frameSrc: deps.frameSrc });

  const page = (status: number, html: string, extra: Record<string, string> = {}): AppResponse => ({
    status,
    headers: { ...security, 'Content-Type': HTML, 'Cache-Control': NO_STORE, ...extra },
    body: method === 'HEAD' ? null : html,
  });
  const missing = (reason: MissingReason) => page(404, missingPage(reason));

  const isUnlock = method === 'POST' && req.path === UNLOCK_PATH;
  const isBeacon = deps.beacon !== undefined && req.path === BEACON_PATH;
  const widget = !production && kind !== undefined ? (deps.feedback ?? null) : null;
  const isWidget = widget !== null && (method === 'GET' || method === 'HEAD') && req.path === FEEDBACK_SCRIPT_PATH;
  const isPlatform = !isUnlock && !isBeacon && !isWidget && deps.platform !== undefined && req.path.startsWith(PLATFORM_PREFIX);
  if (method !== 'GET' && method !== 'HEAD' && !isUnlock && !isPlatform && !isBeacon) {
    return page(405, errorPage('Method not allowed', 'This address only serves files.'), {
      Allow: 'GET, HEAD',
    });
  }

  // ── where to report this host — any app host, before anything else ──
  if ((method === 'GET' || method === 'HEAD') && req.path === REPORT_WELL_KNOWN_PATH) {
    return wellKnownReport(req, deps, method, security);
  }

  // ── the app (unknown hosts are counted per client IP) ──
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
  if (deps.unknownHosts?.isThrottled(req.clientIp) && !deps.store.knowsLiveHost(req.target)) {
    return throttled();
  }
  const { app, version } = await deps.store.resolve(req.target);
  if (!app) return unknownApp();
  security = {
    ...appSecurityHeaders({
      noindex,
      frameSrc: deps.frameSrc,
      frameAncestors: withFrameAncestors(parseFrameAncestors(app.frameAncestors), [
        deps.dashboardOrigin,
        ...(production && app.galleryVisible ? (deps.galleryFrameAncestors ?? []) : []),
      ]),
    }),
    [APP_HEADER]: app.slug,
  };
  // A version host without its version counts like an unknown host: `--v<N>` takes any N.
  if (req.target.kind === 'version' && !version && deps.unknownHosts && !(await deps.unknownHosts.allow(req.clientIp))) {
    return throttled();
  }
  if (!isBeacon && !isWidget) deps.signal?.(app.id, 'request');

  // ── taken down by a super-admin: 451 on every host and path ──
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

  // ── primary custom domain: the production host redirects there ──
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
  const token = readCookieValue(req.header('cookie'), appAccessCookieName(deps.secureCookies ?? true));
  const hasAppAccess =
    app.visibility === 'password' && token !== null && deps.accessSecret !== null
      ? verifyAppAccessToken(token, app.id, deps.accessSecret, (deps.now ?? Date.now)())
      : false;
  const locked = decideVisibility({ visibility: app.visibility, hasAppAccess }).action === 'password';
  if (isPlatform || isBeacon) {
    if (locked && !(isPlatform && deps.platformSkipsGate?.(method, req.path))) {
      return {
        status: 401,
        headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
        body: JSON.stringify({ error: 'password_required', message: 'This app is password-protected — unlock it first.' }),
      };
    }
    if (isBeacon) {
      const b = await deps.beacon!(req, app, version);
      return { ...b, headers: { ...b.headers, ...security } };
    }
    const r = await deps.platform!(req, { app, target: req.target });
    if (r.status >= 500) deps.signal?.(app.id, '5xx', req.path);
    // A throttled 429 is not recorded: a flood must cost nothing past the limiter.
    else if (r.status >= 400 && r.status !== 429) deps.signal?.(app.id, '4xx', req.path);
    return { ...r, headers: withAppSecurity(r.headers, security) };
  }
  if (locked) {
    const next = safeNext(req.query ? `${req.path}?${req.query}` : req.path);
    return page(401, passwordPage({ next }));
  }
  if (isWidget) return serveWidget(req, widget, security);

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
    deps.signal?.(app.id, '5xx', req.path);
    throw err;
  }
  const hit = resolveServePath({ requestPath: decoded, routingMode: 'spa', has: (p) => manifest.has(p) });
  const entry = hit.kind === 'file' ? manifest.get(hit.path) : undefined;
  if (hit.kind !== 'file' || !entry) {
    if (production) {
      const map = await serveSourceMap(req, deps, { app, decoded, manifest, security });
      if (map) return map;
    }
    const assetName = deps.assets ? assetNameOf(decoded) : null;
    if (assetName !== null) {
      const served = await serveAsset(req, deps.assets!, {
        app,
        name: assetName,
        scope: assetScopeFor(req.target.kind, version.id),
        security,
        published: !noindex,
      });
      if (served) return served;
    }
    deps.signal?.(app.id, '404', req.path);
    return missing('no-file');
  }

  const split =
    production && entry.built && mayCarryInlineSourceMap(hit.path)
      ? await deps.store.splitSourceMap(entry.sha256, hit.path)
      : null;
  const contentType = contentTypeForPath(hit.path);
  const withWidget = widget !== null && contentType.startsWith('text/html') && (await deps.store.feedbackEnabled(version.id));
  const etag = split
    ? etagFor(`${entry.sha256}-nomap`)
    : withWidget
      ? etagFor(`${entry.sha256}-fb${version.number}-${widget.hash}`)
      : etagFor(entry.sha256);
  const headers: Record<string, string> = {
    ...security,
    'Content-Type': contentType,
    ETag: etag,
    'Cache-Control': cacheControlFor({
      path: hit.path,
      query: req.query,
      isPrivate: app.visibility !== 'public',
    }),
    ...(contentType.startsWith('text/html') ? { 'Server-Timing': `${VERSION_TIMING_METRIC};desc="${version.number}"` } : {}),
  };
  const countView = () => {
    if (production && method === 'GET' && contentType.startsWith('text/html')) deps.pageView?.(app.id, pageViewOf(req, deps));
  };
  if (isNotModified(req.header('if-none-match'), etag)) {
    countView();
    return { status: 304, headers, body: null };
  }
  const stored = split ? split.code : await deps.store.blob(entry.sha256);
  if (!stored) {
    // metadata without bytes — fail closed
    deps.signal?.(app.id, '5xx', req.path);
    return missing('no-file');
  }
  const bytes = withWidget ? injectBeforeBodyEnd(stored, feedbackScriptTag(app.slug, version.number)) : stored;
  headers['Content-Length'] = String(bytes.length);
  countView();
  return { status: 200, headers, body: method === 'HEAD' ? null : bytes };
}

/** `GET /__drobek/feedback.js` on a preview or version host: the widget, revalidated by its ETag. */
function serveWidget(req: AppRequest, widget: FeedbackWidget, security: Record<string, string>): AppResponse {
  const etag = etagFor(`feedback-${widget.hash}`);
  const headers: Record<string, string> = {
    ...security,
    'Content-Type': 'text/javascript; charset=utf-8',
    ETag: etag,
    'Cache-Control': 'no-cache',
  };
  if (isNotModified(req.header('if-none-match'), etag)) return { status: 304, headers, body: null };
  headers['Content-Length'] = String(widget.script.length);
  return { status: 200, headers, body: req.method.toUpperCase() === 'HEAD' ? null : widget.script };
}

/** What the page-view counter is told about a request (it keeps none of it but counts). */
function pageViewOf(req: AppRequest, deps: HandlerDeps): PageViewInput {
  return {
    path: req.path,
    host: req.header('host'),
    userAgent: req.header('user-agent'),
    referer: req.header('referer'),
    clientIp: req.clientIp,
    secFetchDest: req.header('sec-fetch-dest'),
    purpose: req.header('sec-purpose') ?? req.header('purpose'),
    frameOrigins: [...(deps.dashboardOrigin ? [deps.dashboardOrigin] : []), ...(deps.galleryFrameAncestors ?? [])],
  };
}

/**
 * `/<bundle>.map` on the production host / a custom domain, when
 * the version has no file there: the inline source map of the built JS/CSS
 * bundle `<bundle>` (null → not such a request; the caller answers as before).
 */
async function serveSourceMap(
  req: AppRequest,
  deps: HandlerDeps,
  input: { app: ServeApp; decoded: string; manifest: ServedManifest; security: Record<string, string> }
): Promise<AppResponse | null> {
  const path = normalizeRequestPath(input.decoded);
  if (!path?.endsWith('.map')) return null;
  const bundlePath = path.slice(0, -'.map'.length);
  const bundle = input.manifest.get(bundlePath);
  if (!bundle?.built || !mayCarryInlineSourceMap(bundlePath)) return null;
  const split = await deps.store.splitSourceMap(bundle.sha256, bundlePath);
  if (!split) return null;
  const etag = etagFor(`${bundle.sha256}-map`);
  const headers: Record<string, string> = {
    ...input.security,
    'Content-Type': contentTypeForPath(path),
    ETag: etag,
    'Cache-Control': cacheControlFor({ path, query: req.query, isPrivate: input.app.visibility !== 'public' }),
  };
  if (isNotModified(req.header('if-none-match'), etag)) return { status: 304, headers, body: null };
  headers['Content-Length'] = String(split.map.length);
  return { status: 200, headers, body: req.method.toUpperCase() === 'HEAD' ? null : split.map };
}

/**
 * Which asset set a host serves: the production host and custom
 * domains only the set the publish of their version froze; the preview host
 * the draft; a version host that version's set, or the draft when it was
 * never published.
 */
function assetScopeFor(kind: AppHostTarget['kind'], versionId: string): AssetScope {
  if (kind === 'preview') return 'draft';
  return kind === 'version' ? { versionId, orDraft: true } : { versionId };
}

/** An uploaded asset of the app, or null when the app has none by that name. */
async function serveAsset(
  req: AppRequest,
  assets: AssetSource,
  input: { app: ServeApp; name: string; scope: AssetScope; security: Record<string, string>; published: boolean }
): Promise<AppResponse | null> {
  const asset = await assets.find(input.app.id, input.name, input.scope);
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
 * files).
 */
function withAppSecurity(headers: Record<string, string | string[]>, security: Record<string, string>): Record<string, string | string[]> {
  let moduleCsp: string | null = null;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === CSP_HEADER.toLowerCase()) moduleCsp = (Array.isArray(v) ? v.join(', ') : v).trim() || null;
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
  // Only the app is needed: a version host looks up its production host, whatever N it names.
  const target = req.target?.kind === 'version' ? { kind: 'prod' as const, slug: req.target.slug } : req.target;
  const app = target ? (await deps.store.resolve(target)).app : null;
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
