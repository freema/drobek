/**
 * The proxy module's app-host route (§5.6):
 *
 *   GET|HEAD|POST|PUT|PATCH|DELETE  /__drobek/v1/proxy/:upstream/*
 *
 * Order of the checks — the cheap, app-level ones first, the network last:
 *   1. `X-Drobek-SDK: 1` on EVERY method (not only mutations): a call spends
 *      the owner's secret, so a cross-site page must not trigger even a GET;
 *   2. the upstream is assigned to THIS app (config) — else 403;
 *   3. its `call` rule for the caller (principal from the end-user cookie) —
 *      401 / 403;
 *   4. rate limits: per client IP on a `public` upstream, the app-wide
 *      PROXY_CALLS_PER_MIN, the assignment's own `rateLimit` — 429;
 *   5. a slot among the calls in flight (PROXY_MAX_CONCURRENT for the
 *      process, PROXY_MAX_CONCURRENT_PER_APP per app) — else 429 proxy_busy;
 *   6. the upstream is registered in the app's workspace — else 404 — it is
 *      the RECORD the assignment is bound to (`id`, NSO-326) — else 403
 *      upstream_replaced — and THIS app is on its allow-list
 *      (`allowed_app_ids`, set when a workspace admin confirmed the
 *      assignment; NSO-322 H3) — else 403; an unbound (older) assignment is
 *      bound here;
 *   7. @drobek/proxy `forwardToUpstream`: method + path allow-lists, the
 *      secret injected server-side, Cookie/Authorization/browser headers
 *      stripped, SSRF guard (pinned IP, ports 80/443, no redirects, 20 s,
 *      5 MiB), an encoded body decoded within the cap, the response relayed
 *      with allow-listed headers and `Cache-Control: no-store`.
 */
import { ModuleError, perIpLimitKey, respond, ruleIsPublic, type ModuleContext, type ModuleRequest, type ModuleRouter } from '@drobek/modules';
import {
  ProxyError,
  acquireProxySlot,
  forwardToUpstream,
  proxyErrorStatus,
  resolveUpstreamForForward,
  upstreamAllowsApp,
  type ProxyErrorCode,
} from '@drobek/proxy';
import { dbErrorForLog } from '@drobek/db';
import { bindAssignment } from './binding.js';
import { DEFAULT_CALLS_PER_MIN, DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP, assignmentOf, callRuleOf, type ProxyConfig } from './config.js';

/** Max request body forwarded to an upstream (the apps host caps platform bodies at 1 MiB too). */
export const PROXY_MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_MS = 60_000;
const SDK_HEADER = 'x-drobek-sdk';

export interface ProxyRouteOptions {
  /**
   * Where PROXY_ALLOWED_HOSTS / PROXY_ALLOWED_PORTS / PROXY_* timeouts and
   * DROBEK_MASTER_KEY come from (default: process.env at call time).
   */
  env?: () => NodeJS.ProcessEnv;
}

type Ctx = ModuleContext<ProxyConfig>;

/** A ProxyError → the uniform module error (same code, same status, secret-free message). */
export function toModuleError(err: ProxyError): ModuleError {
  const code: ProxyErrorCode = err.code;
  // proxy_busy: slots free up as calls finish (≤ 20 s) — worth a retry soon.
  const headers = code === 'proxy_busy' ? { 'Retry-After': '1' } : undefined;
  return new ModuleError(code, err.message, { status: proxyErrorStatus(code), headers });
}

async function limitOf(ctx: Ctx, name: string, fallback: number): Promise<number> {
  const v = (await ctx.limits())[name];
  return typeof v === 'number' && v > 0 ? v : fallback;
}

async function enforce(ctx: Ctx, bucket: string, key: string, max: number): Promise<void> {
  const r = await ctx.rateLimit(bucket, key, max, WINDOW_MS);
  if (!r.ok) {
    throw new ModuleError('rate_limited', `Too many requests — at most ${max} per ${WINDOW_MS / 1000} s.`, {
      details: { limit: max, window_seconds: WINDOW_MS / 1000 },
      headers: { 'Retry-After': String(r.retryAfterSec) },
    });
  }
}

/** The client's headers as a Headers object (anything a Headers refuses is dropped). */
function clientHeaders(req: ModuleRequest<unknown>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(req.headers())) {
    try {
      out.append(k, v);
    } catch {
      /* an unrepresentable header never reaches the upstream */
    }
  }
  return out;
}

export function proxyHandler(opts: ProxyRouteOptions = {}) {
  return async (req: ModuleRequest<unknown>, ctx: Ctx) => {
    // 1) Every call comes from the SDK (a custom header = a CORS preflight the apps origin never grants).
    if (req.header(SDK_HEADER)?.trim() !== '1') {
      throw new ModuleError(
        'csrf_rejected',
        'Call upstreams through drobek.proxy.fetch(upstream, path, init) — every proxy call needs the X-Drobek-SDK: 1 header.'
      );
    }

    // 2) Assigned to this app?
    const name = req.params.upstream;
    const assignment = assignmentOf(ctx.config, name);
    if (!assignment) {
      throw new ModuleError(
        'forbidden',
        `This app may not call the upstream "${name}". Assign it with configure_module('proxy', { upstreams: { "${name}": { rules: { call: "user" } } } }) — the app owner confirms it.`,
        { details: { reason: 'upstream_not_assigned', upstream: name } }
      );
    }

    // 3) The call rule.
    const rule = callRuleOf(assignment);
    const d = ctx.rules.decide(rule);
    if (!d.ok) {
      throw d.status === 401
        ? new ModuleError('unauthorized', 'Sign in to this app first.')
        : new ModuleError('forbidden', 'You are not allowed to call this upstream in this app.');
    }

    // 4) Rate limits (independent of the rule).
    //    No resolved client IP → no per-IP bucket (never a shared `unknown`
    //    one, NSO-328); the app-wide and per-upstream limits still apply.
    const ip = ruleIsPublic(rule) ? perIpLimitKey(req.clientIp, 'mod:proxy:public-ip') : null;
    if (ip !== null) {
      const perIp = await limitOf(ctx, 'PROXY_PUBLIC_CALLS_PER_MIN_PER_IP', DEFAULT_PUBLIC_CALLS_PER_MIN_PER_IP);
      await enforce(ctx, 'public-ip', `${name}:${ip}`, perIp);
    }
    await enforce(ctx, 'calls', 'app', await limitOf(ctx, 'PROXY_CALLS_PER_MIN', DEFAULT_CALLS_PER_MIN));
    if (assignment.rateLimit) await enforce(ctx, 'upstream', name, assignment.rateLimit);

    // 5) A slot among the calls in flight (each may buffer 5 MiB for 20 s).
    const env = opts.env?.() ?? process.env;
    let release: (() => void) | undefined;
    const started = Date.now();
    try {
      release = acquireProxySlot(ctx.app.id, env);
      // 6 + 7) Resolve in the app's workspace, check the binding, forward.
      const upstream = await resolveUpstreamForForward(ctx.app.workspaceId, name, ctx.db).catch((err: unknown) => {
        if (err instanceof ProxyError && err.code === 'not_found') {
          throw new ModuleError(
            'not_found',
            `No upstream "${name}" is registered in this app's workspace — a workspace admin registers it in the drobek dashboard (workspace → Upstreams).`,
            { details: { reason: 'upstream_not_registered', upstream: name } }
          );
        }
        throw err;
      });
      if (assignment.id !== undefined && assignment.id !== upstream.id) {
        throw new ModuleError(
          'forbidden',
          `The upstream "${name}" was deleted and registered again after a workspace admin confirmed it for this app, so it is a new upstream. Remove it from the proxy config and add it again — an admin confirms the new one.`,
          { details: { reason: 'upstream_replaced', upstream: name } }
        );
      }
      if (!upstreamAllowsApp(upstream, ctx.app.id)) {
        throw new ModuleError(
          'forbidden',
          `A workspace admin has not allowed this app to call the upstream "${name}". An admin confirms the assignment in the drobek dashboard — if it was assigned before the upstream was registered, remove it from the proxy config and add it again.`,
          { details: { reason: 'upstream_not_allowed', upstream: name } }
        );
      }
      if (assignment.id === undefined) {
        // An older (name-only) assignment: the app is on THIS record's allow-list,
        // so an admin confirmed this record — bind it (best effort, the call goes on).
        await bindAssignment(ctx.db, ctx.app.id, name, upstream.id, { onlyIfUnbound: true }).catch((err: unknown) =>
          ctx.log.warn('proxy binding not stored', { app_id: ctx.app.id, upstream: name, error: dbErrorForLog(err) })
        );
      }
      const result = await forwardToUpstream({
        upstream,
        method: req.method,
        subpath: req.params['*'] ?? '',
        search: req.rawQuery,
        headers: clientHeaders(req),
        body: Buffer.isBuffer(req.body) ? req.body : undefined,
        env,
      });
      ctx.log.info('proxy call', {
        app_id: ctx.app.id,
        upstream: name,
        method: req.method,
        status: result.status,
        ms: Date.now() - started,
      });
      return respond(result.status, result.body, result.headers);
    } catch (err) {
      if (err instanceof ProxyError) {
        ctx.log.info('proxy call refused', { app_id: ctx.app.id, upstream: name, method: req.method, error: err.code });
        if (err.code === 'ssrf_blocked') {
          await ctx.audit('blocked', { upstream: name, reason: err.message }).catch(() => undefined);
        }
        throw toModuleError(err);
      }
      throw err;
    } finally {
      release?.();
    }
  };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export function registerRoutes(opts: ProxyRouteOptions = {}) {
  return (r: ModuleRouter<ProxyConfig>): void => {
    const handler = proxyHandler(opts);
    for (const m of METHODS) {
      // Raw body (any content type) up to 1 MiB; the default CSRF guard covers the mutations too.
      (r[m] as (path: string, o: object, h: typeof handler) => void)('/:upstream/*', { bodyTypes: ['raw'], maxBodyBytes: PROXY_MAX_BODY_BYTES }, handler);
    }
  };
}
