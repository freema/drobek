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
import { normalizeConfirmItems, type AnyModule, type EmailMessage, type HookApp, type Limits, type MailEnvelope, type ModuleContext, type Principal } from './contract.js';
import { mergePatch } from './merge-patch.js';
import { collectRoutes, errorResult, isReadable, matchRoute, runRoute, type PipelineResult } from './router.js';
import { decideAccess } from './rules.js';
import { CORE_ERROR_CODES, ModuleError } from './errors.js';
import { assertSignInSender, capEmailText, emailKind, resolveRecipients, sanitizeSubject } from './email.js';
import type { MailGuard } from './mail-guard.js';
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
  /** The app owners' addresses (`{ appOwners: true }` recipients; default none). */
  owners?: string[];
  /**
   * The operator-wide e-mail guard core runs around every `ctx.email.send`
   * (e.g. `memoryMailGuard(...)`): pass one to test how the module behaves
   * while module e-mail is paused. Default: no guard.
   */
  mailGuard?: MailGuard;
  /**
   * Slot → the contributions `ctx.contributions(slot)` returns (as the
   * slot's schema would have parsed them; default: none — `[]`).
   */
  contributions?: Record<string, unknown[]>;
}

export interface TestRequestInit {
  /** A JSON body. */
  body?: unknown;
  /** A raw body instead (set its `content-type` in `headers`), e.g. multipart/form-data. */
  rawBody?: Buffer | string;
  /** A `bodyTypes: ['file']` route streams `rawBody` in chunks of this many bytes (default 64 KiB). */
  chunkSize?: number;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Default `127.0.0.1`; `null` = no resolved client IP (per-IP limits are skipped). */
  clientIp?: string | null;
}

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON (or the raw text when the body is not JSON). */
  body: unknown;
  /** The raw response bytes (a streamed body is collected). */
  bytes: Buffer;
  /** Request body bytes a streaming (`file`) route pulled before it stopped. */
  bodyBytesRead: number;
}

export interface ModuleTestContext {
  ctx: ModuleContext<any>;
  /**
   * Run `method path` through the production pipeline. SDK header + same
   * Origin are sent by default. Rejects — where production answers
   * `500 internal_error` — when the handler throws something other than a
   * ModuleError, or a ModuleError whose code is neither a core code nor in
   * the module's `errors`.
   */
  request(method: string, path: string, init?: TestRequestInit): Promise<TestResponse>;
  /** Audit rows the module wrote (`<module>.<action>`). */
  audits: { action: string; meta: Record<string, unknown> }[];
  /**
   * E-mails the module sent (resolved recipients, one entry per send). When
   * the module under test is the mail authority (`mail`), its own `prepare`
   * runs first (limits, envelope) exactly as core runs it.
   */
  emails: ({ to: string[]; subject: string; text: string; kind: 'sign_in' | 'notification' } & MailEnvelope)[];
  /** Change who is calling. */
  setPrincipal(principal: Principal): void;
  /**
   * Run the module's `confirmRequired(before, after, context)` the way
   * configure_module does — both configs merged over configDefaults and
   * validated, the context naming the test app and `db` ([] without a
   * confirmRequired).
   */
  confirm(before: Record<string, unknown>, after: Record<string, unknown>): Promise<string[]>;
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
    contributions: <T,>(slot: string) => [...(opts.contributions?.[slot] ?? [])] as T[],
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
        const kind = emailKind(message.to);
        // Core's rule: only the module that owns end-user sessions sends sign-in codes.
        assertSignInSender(kind, module.name, module.endUsers ? module.name : null);
        const to = await resolveRecipients(message.to, { principal, config, owners: async () => opts.owners ?? [] });
        if (to.length === 0) return { sent: 0 };
        const guardMeta = { app_id: app.id, workspace_id: app.workspaceId, module: module.name, kind };
        await opts.mailGuard?.assertOpen(guardMeta);
        let envelope: MailEnvelope = {};
        if (module.mail) {
          envelope = await module.mail.prepare({
            app,
            module: module.name,
            kind,
            recipients: to.length,
            config,
            limits,
            rateLimit: (bucket, key, max, windowMs) => rateLimit(`${bucket}:${key}`, max, windowMs),
            log: opts.log ?? noopLogger,
          });
        }
        await opts.mailGuard?.admit(to.length, guardMeta);
        emails.push({ to, subject: sanitizeSubject(message.subject), text: capEmailText(message.text), kind, ...envelope });
        return { sent: to.length };
      },
      signInShare: opts.mailGuard?.budgets?.perAppSignIn,
    },
  });

  const routes = collectRoutes(module.routes?.bind(module) as never);
  // As in production: a route may answer the core codes and the module's own `errors` only.
  const errorCodes = new Set([...CORE_ERROR_CODES, ...(module.errors ?? []).map((e) => e.code)]);

  const toResponse = async (r: PipelineResult, bodyBytesRead = 0): Promise<TestResponse> => {
    let bytes: Buffer;
    if (isReadable(r.body)) {
      const chunks: Buffer[] = [];
      for await (const c of r.body) chunks.push(Buffer.from(c as Uint8Array));
      bytes = Buffer.concat(chunks);
    } else {
      bytes = r.body === null ? Buffer.alloc(0) : Buffer.from(r.body);
    }
    let body: unknown = r.body === null ? null : bytes.toString('utf8');
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the text */
      }
    }
    return { status: r.status, headers: r.headers, body, bytes, bodyBytesRead };
  };

  /** `raw` as the adapter's pull stream, in `size`-byte chunks; counts what was pulled. */
  const chunked = (raw: Buffer | null, size: number, read: { n: number }): AsyncIterableIterator<Buffer> => {
    let offset = 0;
    let done = false;
    const iter: AsyncIterableIterator<Buffer> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next() {
        if (done || !raw || offset >= raw.length) {
          done = true;
          return { value: undefined, done: true };
        }
        const chunk = raw.subarray(offset, offset + size);
        offset += chunk.length;
        read.n += chunk.length;
        return { value: chunk, done: false };
      },
      async return() {
        done = true;
        return { value: undefined, done: true };
      },
    };
    return iter;
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
    async confirm(before, after) {
      if (!module.confirmRequired) return [];
      const parse = (patch: Record<string, unknown>) => {
        const r = module.configSchema.safeParse(mergePatch(module.configDefaults, patch));
        if (!r.success) throw new Error(`confirm: config does not pass ${module.name}.configSchema: ${r.error.message}`);
        return r.data;
      };
      return normalizeConfirmItems(await module.confirmRequired(parse(before), parse(after), { app, db: opts.db ?? noDb() })).changes;
    },
    async request(method, path, init = {}) {
      const upper = method.toUpperCase();
      const mutating = !['GET', 'HEAD'].includes(upper);
      const headers: Record<string, string> = {
        ...(mutating ? { origin, 'x-drobek-sdk': '1' } : {}),
        ...(init.body !== undefined && init.rawBody === undefined ? { 'content-type': 'application/json' } : {}),
      };
      for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
      const raw =
        init.rawBody !== undefined
          ? Buffer.from(init.rawBody)
          : init.body === undefined
            ? null
            : Buffer.from(JSON.stringify(init.body));
      const qs = new URLSearchParams(init.query ?? {}).toString();
      const hit = matchRoute(routes, upper, path);
      if (hit.kind === 'not_found') return toResponse(errorResult(new ModuleError('not_found', `no route ${upper} ${path}`), module.name));
      if (hit.kind === 'method_not_allowed') {
        return toResponse(errorResult(new ModuleError('method_not_allowed', `Use ${hit.allow.join(' or ')}.`), module.name));
      }
      const read = { n: 0 };
      const res = await runRoute(
        {
          method: upper,
          path,
          query: qs,
          header: (n) => headers[n.toLowerCase()] ?? null,
          headers: () => ({ ...headers }),
          clientIp: init.clientIp === undefined ? '127.0.0.1' : init.clientIp,
          readBody: async (limit) => (raw && raw.length > limit ? 'too_large' : raw),
          bodyStream: () => chunked(raw, init.chunkSize ?? 64 * 1024, read),
        },
        hit.route,
        hit.params,
        {
          module: module.name,
          errorCodes,
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
      return toResponse(res, read.n);
    },
  };
}
