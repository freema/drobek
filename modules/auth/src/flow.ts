/**
 * Provider sign-in (NSO-348) — the flow that carries an IdP's answer from the
 * ONE callback on the dashboard host back to the app host, without ever
 * sharing a cookie between the two:
 *
 *   1. app host   POST /__drobek/v1/auth/begin { provider, return_to? }
 *                 (SDK CSRF header) → a random state id, a nonce, a PKCE
 *                 verifier and a FLOW token are made; Redis
 *                 `drobek:eu-oauth:<id>` = { app_id, host, provider, nonce,
 *                 code_verifier, return_to, flow: SHA-256(flow token) }
 *                 (10 min); the state sent to the IdP is `<id>.<HMAC>` — the
 *                 HMAC (key: HKDF of DROBEK_MASTER_KEY) binds the id to the
 *                 app, host, provider and nonce; the flow token goes to the
 *                 browser as a host-only HttpOnly cookie scoped to
 *                 `/__drobek/v1/auth/complete`; `provider.begin()` answers
 *                 the IdP URL.
 *   2. IdP → dashboard host  GET|POST /__drobek/auth/callback/<provider>:
 *                 the state is consumed (GETDEL — single use) and its HMAC
 *                 and provider checked; the app comes from the STATE only;
 *                 `provider.callback()` answers the identity; a verified
 *                 address the allowlist admits is upserted / linked; a
 *                 one-time handoff code (32 random bytes) is stored for 60 s
 *                 as `drobek:eu-handoff:<code>` = { app_id, host, user_id,
 *                 provider, flow, return_to } → 302 to
 *                 `<apps scheme>://<host>/__drobek/v1/auth/complete?code=…`.
 *   3. app host   GET /__drobek/v1/auth/complete?code= → the code is consumed
 *                 (GETDEL); it must name THIS app and THIS host, and the
 *                 browser must hold the flow cookie of step 1 (a callback URL
 *                 an attacker hands a victim signs nobody in — login CSRF);
 *                 the user is decided again (`currentUser`) → the host-only
 *                 session cookie + 302 to `return_to` (a path on this host).
 *
 * The dashboard session is never read or written. Failures answer small HTML
 * pages without IdP details.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { appsOrigin, dashboardOrigin } from '@drobek/apps';
import { safeReturnPath } from '@drobek/auth';
import { getRedis } from '@drobek/core';
import {
  AUTH_PROVIDER_ID_RE,
  END_USER_SESSION_TTL_SEC,
  ModuleError,
  authIdentitySchema,
  createEndUserSession,
  endUserCookieHeader,
  endUserCookiesSecure,
  perIpLimitKey,
  respond,
  z,
  type AuthSignedInObserver,
  type EndUserCallbackInput,
  type EndUserCallbackResult,
  type EndUserRedis,
  type ModuleContext,
  type ModuleResponse,
} from '@drobek/modules';
import { decideSignIn, type AuthConfig } from './config.js';
import { currentUser } from './current.js';
import {
  PROVIDER_CALL_TIMEOUT_MS,
  SIGNED_IN_SLOT,
  enabledProvider,
  errorKind,
  notifySignedIn,
  providerConfig,
  providerEnv,
  providerSecrets,
  withTimeout,
} from './providers.js';
import { isWorkspaceEditor, providerSignIn, setUserRole } from './users.js';

type Ctx = ModuleContext<AuthConfig>;

/** How long a started sign-in waits for the IdP. */
export const STATE_TTL_SEC = 10 * 60;
/** How long the handoff code of a finished callback lives. */
export const HANDOFF_TTL_SEC = 60;
/** The path the flow cookie is scoped to (the only request that reads it). */
export const COMPLETE_PATH = '/__drobek/v1/auth/complete';
/** Per client IP, per 15 minutes: IdP callbacks on the dashboard host (the server default — no workspace is known yet). */
export const CALLBACK_LIMIT = 'AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN';
const CALLBACK_WINDOW_MS = 15 * 60_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const FLOW_COOKIE = '__Secure-drobek_eu_flow';
const FLOW_COOKIE_INSECURE = 'drobek_eu_flow';

export function stateKey(id: string): string {
  return `drobek:eu-oauth:${id}`;
}

export function handoffKey(code: string): string {
  return `drobek:eu-handoff:${code}`;
}

/** The Redis commands the flow uses (ioredis-compatible; GETDEL = single use). */
interface FlowRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

function flowRedis(): FlowRedis {
  return getRedis() as unknown as FlowRedis;
}

function sessionRedis(): EndUserRedis {
  return getRedis() as unknown as EndUserRedis;
}

/** 32 random bytes, base64url (43 characters). */
function token(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The state signing key: HKDF-SHA256 over DROBEK_MASTER_KEY (64 hex chars)
 * under its own label. null without a valid master key — provider sign-in is
 * then unavailable (fail closed).
 */
export function stateSecret(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.DROBEK_MASTER_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'hex'), Buffer.alloc(0), 'drobek/eu-oauth-state/v1', 32));
}

function signState(secret: Buffer, parts: { id: string; app_id: string; host: string; provider: string; nonce: string }): string {
  return createHmac('sha256', secret)
    .update(['v1', parts.id, parts.app_id, parts.host, parts.provider, parts.nonce].join('\n'))
    .digest('base64url');
}

/** `<apps scheme>://<host>` — the origin the runtime also uses for the app host's CSRF check. */
function hostOrigin(host: string): string {
  return `${appsOrigin().scheme}://${host}`;
}

/** The ONE redirect URI of provider `id` on this server (register it at the IdP). */
export function callbackUrl(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${dashboardOrigin(env)}/__drobek/auth/callback/${id}`;
}

/** The Host header, if it is a plain host[:port] (lower case). */
function safeHost(host: string | null): string | null {
  const h = (host ?? '').trim().toLowerCase();
  return /^[a-z0-9.-]+(?::\d{1,5})?$/.test(h) ? h : null;
}

/** An IdP URL `begin` may send the browser to: https (http only outside production), no credentials. */
function idpUrl(value: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const httpOk = env.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !(httpOk && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

// ── records ──────────────────────────────────────────────────────────────────

const stateRecordSchema = z.object({
  v: z.literal(1),
  app_id: z.string().min(1),
  host: z.string().min(1),
  provider: z.string().regex(AUTH_PROVIDER_ID_RE),
  nonce: z.string().regex(TOKEN_RE),
  code_verifier: z.string().regex(TOKEN_RE),
  return_to: z.string(),
  flow: z.string().regex(TOKEN_RE),
});
type StateRecord = z.infer<typeof stateRecordSchema>;

const handoffRecordSchema = z.object({
  v: z.literal(1),
  app_id: z.string().min(1),
  host: z.string().min(1),
  user_id: z.string().min(1),
  provider: z.string().regex(AUTH_PROVIDER_ID_RE),
  is_new: z.boolean(),
  flow: z.string().regex(TOKEN_RE),
  return_to: z.string(),
  name: z.string().max(200).optional(),
});
type HandoffRecord = z.infer<typeof handoffRecordSchema>;

function parseRecord<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (!raw) return null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// ── cookies & pages ──────────────────────────────────────────────────────────

export function flowCookieName(secure: boolean): string {
  return secure ? FLOW_COOKIE : FLOW_COOKIE_INSECURE;
}

/** The flow cookie: host-only (no Domain), scoped to the complete path, HttpOnly, SameSite=Lax, 10 minutes. */
function flowCookieHeader(value: string, secure: boolean): string {
  return [
    `${flowCookieName(secure)}=${value}`,
    `Path=${COMPLETE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${STATE_TTL_SEC}`,
  ].join('; ');
}

function readFlowCookie(header: string | null, secure: boolean): string | null {
  if (!header) return null;
  const name = flowCookieName(secure);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return TOKEN_RE.test(v) ? v : null;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A small HTML page (no script, no style) for the browser that followed a sign-in redirect. */
function signInPage(title: string, message: string, link: { href: string; label: string } | null): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title></head><body><main>`,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '',
    '</main></body></html>',
  ].join('');
}

function pageResponse(status: number, title: string, message: string): ModuleResponse {
  return respond(status, signInPage(title, message, { href: '/', label: 'Back to the app' }), {
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
  });
}

function providerNotEnabled(): ModuleError {
  return new ModuleError('provider_not_enabled', 'This sign-in method is not turned on for this app.', { status: 404 });
}

function providerError(label: string): ModuleError {
  return new ModuleError('provider_error', `Sign-in with ${label} is not available right now. Try again in a moment.`, { status: 502 });
}

// ── 1. begin (app host) ──────────────────────────────────────────────────────

export const beginBody = z.strictObject({
  provider: z.string().regex(AUTH_PROVIDER_ID_RE, 'must be a sign-in provider id (drobek.auth.providers())'),
  return_to: z.string().max(2000).optional(),
});

export async function begin(ctx: Ctx, input: { provider: string; return_to?: string; host: string | null }): Promise<ModuleResponse> {
  const provider = enabledProvider(ctx.contributions, ctx.config, input.provider);
  if (!provider) throw providerNotEnabled();
  const returnTo = input.return_to === undefined ? '/' : safeReturnPath(input.return_to);
  if (returnTo === null) {
    throw new ModuleError('invalid_request', 'return_to must be a path on this host (starting with one "/").', {
      details: [{ path: 'return_to', message: 'must be a path like /dashboard' }],
    });
  }
  const host = safeHost(input.host);
  if (!host) throw new ModuleError('invalid_request', 'The request has no usable Host header.');
  const secret = stateSecret();
  if (!secret) {
    ctx.log.error('auth: provider sign-in needs DROBEK_MASTER_KEY (64 hex characters)', { app_id: ctx.app.id, provider: provider.id });
    throw new ModuleError('unavailable', 'Sign-in providers are not available on this server.');
  }

  const id = token();
  const nonce = token();
  const codeVerifier = token();
  const flow = token();
  const record: StateRecord = {
    v: 1,
    app_id: ctx.app.id,
    host,
    provider: provider.id,
    nonce,
    code_verifier: codeVerifier,
    return_to: returnTo,
    flow: sha256(flow),
  };
  const state = `${id}.${signState(secret, { id, app_id: ctx.app.id, host, provider: provider.id, nonce })}`;
  const store = flowRedis();
  await store.set(stateKey(id), JSON.stringify(record), 'EX', STATE_TTL_SEC);

  let url: string | null = null;
  try {
    const out = await withTimeout(
      provider.begin({
        app: ctx.app,
        config: providerConfig(ctx.config, provider.id),
        secrets: providerSecrets(provider, (name) => ctx.secrets.get(name)),
        env: providerEnv(provider.id),
        redirectUri: callbackUrl(provider.id),
        state,
        nonce,
        codeChallenge: sha256(codeVerifier),
        codeChallengeMethod: 'S256',
        log: ctx.log,
      }),
      PROVIDER_CALL_TIMEOUT_MS
    );
    url = idpUrl((out as { url?: unknown } | null)?.url);
    if (!url) ctx.log.warn('auth: provider begin answered no usable URL', { app_id: ctx.app.id, provider: provider.id });
  } catch (err) {
    ctx.log.warn('auth: provider begin failed', { app_id: ctx.app.id, provider: provider.id, error: errorKind(err) });
  }
  if (!url) {
    await store.getdel(stateKey(id));
    throw providerError(provider.label);
  }
  return respond(200, { url }, { 'Set-Cookie': flowCookieHeader(flow, endUserCookiesSecure()) });
}

// ── 2. callback (dashboard host) ─────────────────────────────────────────────

/** The state a callback carries: `state` (OIDC) or `RelayState` (SAML), in the query or the form body. */
function stateParam(input: Pick<EndUserCallbackInput, 'query' | 'body'>): string | null {
  for (const v of [input.query.state, input.body?.state, input.body?.RelayState, input.query.RelayState]) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

type Page = Extract<EndUserCallbackResult, { kind: 'page' }>;

function page(status: number, title: string, message: string, link?: Page['link']): Page {
  return link ? { kind: 'page', status, title, message, link } : { kind: 'page', status, title, message };
}

const INVALID_STATE = (): Page =>
  page(400, 'Sign-in expired', 'This sign-in link is not valid any more (it expired or was already used). Start the sign-in again from the app.');

/** The `endUsers.callback` of the auth module: the IdP's answer → a handoff code on the app host (or a page). */
export async function providerCallback(input: EndUserCallbackInput<AuthConfig>): Promise<EndUserCallbackResult> {
  const { services } = input;
  const log = services.log;
  if (!AUTH_PROVIDER_ID_RE.test(input.provider)) return page(404, 'Not found', 'There is no such sign-in provider.');

  const ipKey = perIpLimitKey(input.clientIp, 'mod:auth:callback');
  if (ipKey !== null) {
    const max = services.limits()[CALLBACK_LIMIT] ?? 60;
    const r = await services.rateLimit('ip', ipKey, max, CALLBACK_WINDOW_MS);
    if (!r.ok) return page(429, 'Too many sign-ins', 'Too many sign-in attempts from your network. Try again in a few minutes.');
  }

  const m = STATE_RE.exec(stateParam(input) ?? '');
  if (!m) return INVALID_STATE();
  const secret = stateSecret();
  if (!secret) return page(503, 'Sign-in unavailable', 'Sign-in providers are not available on this server.');
  const [, id, sig] = m;
  const record = parseRecord(stateRecordSchema, await flowRedis().getdel(stateKey(id)));
  if (!record) return INVALID_STATE();
  const expected = signState(secret, { id, app_id: record.app_id, host: record.host, provider: record.provider, nonce: record.nonce });
  if (!sameText(sig, expected) || record.provider !== input.provider) {
    log.warn('auth: sign-in callback with a state that does not match', { provider: input.provider });
    return INVALID_STATE();
  }

  const view = await services.app(record.app_id);
  if (!view) return page(404, 'App not available', 'This app does not exist any more.');
  const back = { href: `${hostOrigin(record.host)}${record.return_to}`, label: 'Back to the app' };
  const provider = enabledProvider(services.contributions, view.config, record.provider);
  if (!provider) return page(404, 'Sign-in method turned off', 'This sign-in method is not turned on for this app any more.', back);

  let identity: z.infer<typeof authIdentitySchema>;
  try {
    const raw = await withTimeout(
      provider.callback({
        app: view.app,
        config: providerConfig(view.config, provider.id),
        secrets: providerSecrets(provider, (name) => view.secrets.get(name)),
        env: providerEnv(provider.id),
        redirectUri: callbackUrl(provider.id),
        state: `${id}.${sig}`,
        nonce: record.nonce,
        codeVerifier: record.code_verifier,
        query: input.query,
        body: input.body,
        log,
      }),
      PROVIDER_CALL_TIMEOUT_MS
    );
    const parsed = authIdentitySchema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new Error('the provider answered no valid identity'), { name: 'InvalidIdentity' });
    identity = parsed.data;
  } catch (err) {
    log.warn('auth: provider callback failed', { app_id: view.app.id, provider: provider.id, error: errorKind(err) });
    return page(502, 'Sign-in failed', `Sign-in with ${provider.label} did not work. Try again.`, back);
  }

  const denied = async (reason: string): Promise<void> => {
    await view.audit('sign_in_denied', { provider: provider.id, reason });
  };
  if (!identity.emailVerified) {
    await denied('email_not_verified');
    return page(403, 'E-mail address not verified', `${provider.label} did not confirm this e-mail address, so it cannot be used to sign in.`, back);
  }
  const workspaceEditor = await isWorkspaceEditor(services.db, view.app.workspaceId, identity.email);
  const access = decideSignIn({ config: view.config, email: identity.email, workspaceEditor });
  if (!access.allowed) {
    await denied('not_allowed');
    return page(403, 'Not allowed', 'This address may not sign in to this app.', back);
  }
  const limits = await view.limits();
  const out = await providerSignIn(
    services.db,
    view.app.id,
    { provider: provider.id, subject: identity.subject, email: identity.email, role: access.role },
    limits.END_USERS_MAX_PER_APP ?? 1000
  );
  if (!out.ok) {
    await denied(out.reason);
    if (out.reason === 'limit') return page(429, 'App is full', 'This app cannot take new users right now.', back);
    if (out.reason === 'disabled') return page(403, 'Not allowed', 'This address may not sign in to this app.', back);
    return page(409, 'Account already linked', 'This address already signs in to this app another way. Use that sign-in, or ask the app owner.', back);
  }

  const code = token();
  const handoff: HandoffRecord = {
    v: 1,
    app_id: view.app.id,
    host: record.host,
    user_id: out.row.id,
    provider: provider.id,
    is_new: out.isNew,
    flow: record.flow,
    return_to: record.return_to,
    ...(identity.name ? { name: identity.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 200) } : {}),
  };
  await flowRedis().set(handoffKey(code), JSON.stringify(handoff), 'EX', HANDOFF_TTL_SEC);
  if (out.linked) log.info('auth: account linked to a sign-in provider', { app_id: view.app.id, provider: provider.id, user_id: out.row.id });
  return { kind: 'redirect', location: `${hostOrigin(record.host)}${COMPLETE_PATH}?code=${code}` };
}

// ── 3. complete (app host) ───────────────────────────────────────────────────

const EXPIRED = 'This sign-in link expired or was already used. Start the sign-in again from the app.';

export async function complete(ctx: Ctx, input: { code: string | undefined; host: string | null; cookie: string | null }): Promise<ModuleResponse> {
  const code = input.code ?? '';
  if (!TOKEN_RE.test(code)) return pageResponse(400, 'Sign-in expired', EXPIRED);
  const record = parseRecord(handoffRecordSchema, await flowRedis().getdel(handoffKey(code)));
  if (!record) return pageResponse(400, 'Sign-in expired', EXPIRED);
  const host = safeHost(input.host);
  if (record.app_id !== ctx.app.id || host === null || record.host !== host) {
    ctx.log.warn('auth: a handoff code was used on another app host', { app_id: ctx.app.id, provider: record.provider });
    return pageResponse(400, 'Sign-in expired', EXPIRED);
  }
  const secure = endUserCookiesSecure();
  const flow = readFlowCookie(input.cookie, secure);
  if (!flow || !sameText(sha256(flow), record.flow)) {
    ctx.log.warn('auth: a handoff code arrived without the flow cookie of its sign-in', { app_id: ctx.app.id, provider: record.provider });
    return pageResponse(400, 'Start again', 'Sign-in has to finish in the browser it started in. Start the sign-in again from the app.');
  }

  // Decide again: the allowlist, the user or the provider may have changed since the callback.
  const now = await currentUser(ctx.db, ctx.app, ctx.config, record.user_id, record.provider);
  if (!now) {
    await ctx.audit('sign_in_denied', { provider: record.provider, reason: 'not_allowed' });
    return pageResponse(403, 'Not allowed', 'This address may not sign in to this app.');
  }
  if (now.row.role !== now.user.role) await setUserRole(ctx.db, ctx.app.id, now.user.id, now.user.role);
  const sessionToken = await createEndUserSession(sessionRedis(), ctx.app.id, { ...now.user, provider: record.provider });
  await ctx.audit('sign_in', { user_id: now.user.id, role: now.user.role, new_user: record.is_new, provider: record.provider });
  void notifySignedIn(ctx.contributions<AuthSignedInObserver>(SIGNED_IN_SLOT), {
    app: ctx.app,
    user: { ...now.user, ...(record.name ? { name: record.name } : {}) },
    provider: record.provider,
    isNew: record.is_new,
    db: ctx.db,
    log: ctx.log,
  });
  return respond(302, null, {
    Location: safeReturnPath(record.return_to) ?? '/',
    'Set-Cookie': endUserCookieHeader(sessionToken, { maxAgeSec: END_USER_SESSION_TTL_SEC }, secure),
    'Referrer-Policy': 'no-referrer',
  });
}
