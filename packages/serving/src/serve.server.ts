/**
 * App-serving orchestration (U7, PHY-58). React-router-agnostic: takes a web
 * `Request` + route params and returns a web `Response`, so both the core web
 * app and the saas web app mirror it with a thin route file.
 *
 * Flow: resolve workspace → app pointer (live + has an active deploy) →
 * VISIBILITY GATE (before any file/blob access) → resolve the request path
 * against the active deploy manifest → conditional GET → stream the blob with
 * strict security headers + the immutable/revalidate caching policy.
 *
 * ── Admin-session isolation (deliverable 4 / PHY-58) ──
 * This handler NEVER sets `drobek_session`. The dashboard session cookie stays
 * HttpOnly (app JS cannot read it) and this response carries no Set-Cookie for
 * it. The app-access (password) cookie is tightly PATH-SCOPED to `/:ws/app/:slug`
 * so it is never presented to the dashboard or a sibling app.
 * ⚠️ The session cookie is `Path=/`, so the browser still SENDS it on app paths;
 * that residual same-origin exposure is accepted for M0–M1a and fully fixed by
 * moving the dashboard to its own origin — PHY-98 / U11, OUT OF U7 SCOPE.
 */
import { getSessionUser, isSuperAdmin } from '@drobek/auth';
import { createBlobStoreFromEnv, type BlobStore } from '@drobek/core';
import { incrementServingSignal } from '@drobek/insights';
import { getMembership } from '@drobek/tenancy';
import {
  bustServeCache,
  getServeAppRecord,
  getServeManifest,
  loadAppPasswordHash,
  resolveWorkspaceId,
  type ServeAppRecord,
} from './cache.server.js';
import { contentTypeForPath } from './content-type.js';
import { appResponseHeaders, baseSecurityHeaders } from './csp.js';
import {
  APP_ACCESS_COOKIE,
  appAccessCookieHeader,
  mintAppAccessToken,
  verifyAppAccessToken,
  verifyAppPassword,
} from './password.js';
import {
  cacheControlFor,
  etagFor,
  isNotModified,
  resolveServePath,
} from './resolve.js';
import { decideVisibility } from './visibility.js';

export interface ServeParams {
  wsSlug: string;
  appSlug: string;
  /** The RR splat (`params['*']`) — the path within the app, may be ''. */
  splat: string;
}

let store: BlobStore | null = null;
function blobStore(): BlobStore {
  store ??= createBlobStoreFromEnv();
  return store;
}

/** For tests: inject a fake blob store. */
export function setServeBlobStoreForTests(s: BlobStore | null): void {
  store = s;
}

function appRootPath(wsSlug: string, appSlug: string): string {
  return `/${wsSlug}/app/${appSlug}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...baseSecurityHeaders(),
    },
  });
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal, CSP-compatible (inline style only) password entry page. */
export function renderPasswordPage(opts: {
  actionPath: string;
  error: boolean;
}): Response {
  const errorHtml = opts.error
    ? '<p class="err">Incorrect password. Try again.</p>'
    : '';
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password required</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0f;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#16161c;padding:2rem;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4);width:min(92vw,340px)}
  h1{font-size:1.05rem;margin:0 0 1rem}
  label{display:block;font-size:.8rem;margin:0 0 .35rem;color:#a8a8b3}
  input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #2a2a33;background:#0e0e13;color:#fff;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:1rem;cursor:pointer}
  .err{color:#f87171;font-size:.85rem;margin:.75rem 0 0}
</style></head>
<body><form method="POST" action="${escapeAttr(opts.actionPath)}">
  <h1>This app is password protected</h1>
  <label for="drobek-app-password">Password</label>
  <input id="drobek-app-password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
  ${errorHtml}
</form></body></html>`;
  return new Response(body, {
    status: opts.error ? 401 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...baseSecurityHeaders(),
    },
  });
}

type GateResult = { ok: true } | { ok: false; response: Response };

/** Visibility gate — runs BEFORE any deploy_files / blob access. */
async function gate(
  request: Request,
  app: ServeAppRecord,
  rootPath: string
): Promise<GateResult> {
  if (app.visibility === 'public') return { ok: true };

  const user = await getSessionUser(request);
  const superAdmin = user ? isSuperAdmin(user.email) : false;
  let isMember = false;
  if (user && !superAdmin) {
    isMember = (await getMembership(user.id, app.workspaceId)) !== null;
  }

  let hasAppAccess = false;
  if (app.visibility === 'password') {
    const secret = process.env.UPLOAD_SIGNING_SECRET ?? '';
    const token = readCookie(request, APP_ACCESS_COOKIE);
    hasAppAccess = token ? verifyAppAccessToken(token, app.appId, secret) : false;
  }

  const decision = decideVisibility({
    visibility: app.visibility,
    isMember,
    isSuperAdmin: superAdmin,
    hasAppAccess,
  });
  if (decision.action === 'serve') return { ok: true };
  if (decision.action === 'not-found') return { ok: false, response: notFound() };
  return {
    ok: false,
    response: renderPasswordPage({ actionPath: rootPath, error: false }),
  };
}

/** Resolve the pointer record for a live, deployed app or return a 404 Response. */
async function resolveApp(
  params: ServeParams
): Promise<{ app: ServeAppRecord } | { response: Response }> {
  const workspaceId = await resolveWorkspaceId(params.wsSlug);
  if (!workspaceId) return { response: notFound() };
  const app = await getServeAppRecord(workspaceId, params.appSlug);
  if (!app || app.status !== 'live' || !app.activeDeployId) {
    return { response: notFound() };
  }
  return { app };
}

/**
 * GET/HEAD `/:ws/app/:slug/*` — serve the active deploy's file for the request
 * path behind the visibility gate.
 */
export async function serveApp(
  request: Request,
  params: ServeParams
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', ...baseSecurityHeaders() },
    });
  }

  const resolved = await resolveApp(params);
  if ('response' in resolved) return resolved.response;
  const app = resolved.app;

  // PHY-123 serving signal: tally the request against the resolved app. Cheap +
  // best-effort (incrementServingSignal swallows its own errors) — never blocks
  // or fails the response, and does NOT touch the U7 gate/CSP/cache behavior.
  await incrementServingSignal(app.appId, 'request');

  const rootPath = appRootPath(params.wsSlug, params.appSlug);
  const gateResult = await gate(request, app, rootPath);
  if (!gateResult.ok) return gateResult.response;

  try {
    // activeDeployId is non-null (checked in resolveApp).
    const manifest = await getServeManifest(app.activeDeployId as string);
    const target = resolveServePath({
      requestPath: params.splat,
      routingMode: app.routingMode,
      has: (p) => Object.prototype.hasOwnProperty.call(manifest, p),
    });
    if (target.kind === 'not-found') {
      await incrementServingSignal(app.appId, '404', params.splat);
      return notFound();
    }

    const entry = manifest[target.path];
    if (!entry) {
      // manifest/deploy_files drift — fail closed
      await incrementServingSignal(app.appId, '404', params.splat);
      return notFound();
    }

    const contentType = contentTypeForPath(target.path);
    const etag = etagFor(entry.sha256);
    const { cacheControl } = cacheControlFor(target.isEntry);
    const headers = appResponseHeaders({
      contentType,
      etag,
      cacheControl,
      contentLength: entry.size,
    });

    if (isNotModified(request.headers.get('if-none-match'), etag)) {
      const notModified: Record<string, string> = { ...headers };
      delete notModified['Content-Length'];
      return new Response(null, { status: 304, headers: notModified });
    }

    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    const stream = await blobStore().getStream(entry.sha256);
    if (!stream) {
      // metadata without bytes — fail closed
      await incrementServingSignal(app.appId, '404', params.splat);
      return notFound();
    }
    return new Response(stream, { status: 200, headers });
  } catch (err) {
    // A genuine server fault (manifest/blob read threw) — tally a 5xx signal and
    // return a controlled 500 (previously this threw uncaught → also a 500).
    await incrementServingSignal(app.appId, '5xx');
    throw err;
  }
}

function redirect303(path: string, setCookie?: string): Response {
  const headers = new Headers({
    ...baseSecurityHeaders(),
    Location: path,
    'Cache-Control': 'no-store',
  });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

/**
 * POST `/:ws/app/:slug` — password submission for a `visibility='password'` app.
 * On success sets the path-scoped app-access cookie and redirects to the app;
 * on failure re-renders the password page (401). NEVER touches `drobek_session`.
 */
export async function handleAppPasswordPost(
  request: Request,
  params: ServeParams
): Promise<Response> {
  const rootPath = appRootPath(params.wsSlug, params.appSlug);
  const resolved = await resolveApp(params);
  if ('response' in resolved) return resolved.response;
  const app = resolved.app;

  // Nothing to submit for a non-password app — bounce back to it.
  if (app.visibility !== 'password') return redirect303(rootPath);

  const secret = process.env.UPLOAD_SIGNING_SECRET;
  if (!secret) {
    return new Response('Server misconfigured', {
      status: 500,
      headers: baseSecurityHeaders(),
    });
  }

  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  const hash = await loadAppPasswordHash(app.appId);
  if (!(await verifyAppPassword(password, hash))) {
    return renderPasswordPage({ actionPath: rootPath, error: true });
  }

  const token = mintAppAccessToken(app.appId, secret);
  return redirect303(rootPath, appAccessCookieHeader(token, { path: rootPath }));
}

// Re-export the bust helper so the deploy pipeline can invalidate on activate.
export { bustServeCache };
