/**
 * `createModuleTestContext()` (M1-01) — unit-test a module without a server,
 * Redis or SMTP: a real ModuleContext over in-memory fakes, plus `request()`
 * that runs a route through the SAME pipeline production uses (CSRF, rule,
 * rate limit, body/query validation, uniform errors).
 *
 *   import { createModuleTestContext } from '@drobek/modules/testing';
 *   const t = createModuleTestContext(hello, { config: { greeting: 'Ahoj' } });
 *   const res = await t.request('GET', '/');
 *   expect(res.body).toEqual({ greeting: 'Ahoj', waves: 0 });
 *
 * `db` is whatever drizzle database the test passes (e.g. PGlite with the
 * module's migrations applied); a module that never touches `ctx.db` needs none.
 */
import { noopLogger, type Logger } from '@drobek/core';
import type { DB } from '@drobek/db';
import type { AnyModule, EmailMessage, HookApp, Limits, ModuleContext, Principal } from './contract.js';
import { mergePatch } from './merge-patch.js';
import { collectRoutes, errorResult, matchRoute, runRoute, type PipelineResult } from './router.js';
import { decideAccess } from './rules.js';
import { ModuleError } from './errors.js';
import { resolveRecipients, sanitizeSubject } from './email.js';
import { memoryRateLimiter } from './runtime.js';

export interface ModuleTestOptions {
  /** A partial config (merged over configDefaults, then validated). */
  config?: Record<string, unknown>;
  principal?: Principal;
  /** Secret name → plaintext. */
  secrets?: Record<string, string>;
  /** Limit overrides (the rest come from the module's defaults). */
  limits?: Record<string, number>;
  app?: Partial<HookApp>;
  db?: DB;
  log?: Logger;
  /** The app host the requests come from (default `http://test--preview.apps.localhost`). */
  origin?: string;
  now?: () => number;
}

export interface TestRequestInit {
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  clientIp?: string;
}

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON (or the raw text when the body is not JSON). */
  body: unknown;
}

export interface ModuleTestContext {
  ctx: ModuleContext<any>;
  /** Run `method path` through the production pipeline. SDK header + same Origin are sent by default. */
  request(method: string, path: string, init?: TestRequestInit): Promise<TestResponse>;
  /** Audit rows the module wrote (`<module>.<action>`). */
  audits: { action: string; meta: Record<string, unknown> }[];
  /** E-mails the module sent (resolved recipients). */
  emails: { to: string[]; subject: string; text: string }[];
  /** Change who is calling. */
  setPrincipal(principal: Principal): void;
}

function noDb(): DB {
  return new Proxy({} as DB, {
    get() {
      throw new Error('createModuleTestContext: pass `db` to use ctx.db in this test');
    },
  });
}

export function createModuleTestContext(module: AnyModule, opts: ModuleTestOptions = {}): ModuleTestContext {
  const parsed = module.configSchema.safeParse(mergePatch(module.configDefaults, opts.config ?? {}));
  if (!parsed.success) {
    throw new Error(`createModuleTestContext: config does not pass ${module.name}.configSchema: ${parsed.error.message}`);
  }
  const config = parsed.data;
  const origin = opts.origin ?? 'http://test--preview.apps.localhost';
  const app: HookApp = { id: 'app_test', slug: 'test', workspaceId: 'ws_test', ...opts.app };
  const limits: Limits = Object.freeze({
    ...Object.fromEntries((module.limits ?? []).map((l) => [l.env, l.default])),
    ...opts.limits,
  });
  const rateLimit = memoryRateLimiter(opts.now);
  const audits: ModuleTestContext['audits'] = [];
  const emails: ModuleTestContext['emails'] = [];
  const declared = new Set((module.secrets ?? []).map((s) => s.name));
  let principal: Principal = opts.principal ?? { kind: 'anon' };

  const buildCtx = (): ModuleContext<any> => ({
    app,
    module: module.name,
    principal,
    config,
    db: opts.db ?? noDb(),
    log: opts.log ?? noopLogger,
    rules: { decide: (rule, ownerId) => decideAccess(rule, principal, ownerId) },
    limits: async () => limits,
    rateLimit: (bucket, key, max, windowMs) => rateLimit(`${bucket}:${key}`, max, windowMs),
    secrets: {
      get: async (name) => {
        if (!declared.has(name)) throw new Error(`module "${module.name}" reads undeclared secret "${name}"`);
        return opts.secrets?.[name] ?? null;
      },
    },
    audit: async (action, meta = {}) => {
      audits.push({ action: action.startsWith(`${module.name}.`) ? action : `${module.name}.${action}`, meta });
    },
    email: {
      send: async (message: EmailMessage) => {
        const to = resolveRecipients(message.to, principal, config);
        if (to.length > 0) emails.push({ to, subject: sanitizeSubject(message.subject), text: String(message.text) });
        return { sent: to.length };
      },
    },
  });

  const routes = collectRoutes(module.routes?.bind(module) as never);

  const toResponse = (r: PipelineResult): TestResponse => {
    let body: unknown = r.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the text */
      }
    }
    return { status: r.status, headers: r.headers, body };
  };

  return {
    get ctx() {
      return buildCtx();
    },
    audits,
    emails,
    setPrincipal(p) {
      principal = p;
    },
    async request(method, path, init = {}) {
      const upper = method.toUpperCase();
      const mutating = !['GET', 'HEAD'].includes(upper);
      const headers: Record<string, string> = {
        ...(mutating ? { origin, 'x-drobek-sdk': '1' } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      };
      for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
      const raw = init.body === undefined ? null : Buffer.from(JSON.stringify(init.body));
      const qs = new URLSearchParams(init.query ?? {}).toString();
      const hit = matchRoute(routes, upper, path);
      if (hit.kind === 'not_found') return toResponse(errorResult(new ModuleError('not_found', `no route ${upper} ${path}`), module.name));
      if (hit.kind === 'method_not_allowed') {
        return toResponse(errorResult(new ModuleError('method_not_allowed', `Use ${hit.allow.join(' or ')}.`), module.name));
      }
      const res = await runRoute(
        {
          method: upper,
          path,
          query: qs,
          header: (n) => headers[n.toLowerCase()] ?? null,
          clientIp: init.clientIp ?? '127.0.0.1',
          readBody: async (limit) => (raw && raw.length > limit ? 'too_large' : raw),
        },
        hit.route,
        hit.params,
        {
          module: module.name,
          selfOrigin: origin,
          principal: async () => principal,
          context: async () => buildCtx(),
          limit: async (name) => {
            const v = limits[name];
            if (typeof v !== 'number') throw new Error(`unknown limit "${name}"`);
            return v;
          },
        }
      );
      return toResponse(res);
    },
  };
}
