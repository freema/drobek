/**
 * `createModuleTestContext()` — unit-test a module without a server,
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
 * `coreMigrationsDir()` + `createTestApp()` build that database without any
 * other drobek package:
 *
 *   const pg = new PGlite();
 *   const db = drizzle(pg);
 *   await migrate(db, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
 *   await migrate(db, { migrationsFolder: erp.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_erp', migrationsSchema: 'drizzle' });
 *   const app = await createTestApp(db);
 *
 * `checkSkill(module)` checks the module's SKILL.md like the built-in
 * modules' (skill-check/). `t.runJob(name)` runs one of the module's
 * scheduled `jobs` once (contract 1.2); its `ctx.upstreams.fetch` and
 * `ctx.records.import` are the test's `upstreams` / `records` fakes.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger, type Logger } from '@drobek/core';
import { apps, workspaces, type DB } from '@drobek/db';
import {
  JOB_MAX_INTERVAL_MS,
  JOB_MIN_INTERVAL_MS,
  normalizeConfirmItems,
  parseJobInterval,
  type AnyModule,
  type AppJobContext,
  type EmailMessage,
  type EndUserCallbackResult,
  type HookApp,
  type Limits,
  type MailEnvelope,
  type ModuleContext,
  type Principal,
  type RecordsImportOptions,
  type RecordsImportResult,
  type ServerJobContext,
  type UpstreamRequest,
  type UpstreamResponse,
} from './contract.js';
import { mergePatch } from './merge-patch.js';
import { collectRoutes, errorResult, isReadable, matchRoute, runRoute, type PipelineResult } from './router.js';
import { decideAccess } from './rules.js';
import { CORE_ERROR_CODES, ModuleError } from './errors.js';
import { assertSignInSender, capEmailText, emailKind, resolveRecipients, sanitizeSubject } from './email.js';
import type { MailGuard } from './mail-guard.js';
import { memoryRateLimiter } from './runtime.js';
import { composeModule, loadModuleSet } from './registry.js';
import { buildSdk as buildServerSdk } from './sdk-build.js';

export { checkSkill, checkSkillSources, knownErrorCodes, moduleSkillSource, type CheckSkillOptions, type CheckSkillSourcesOptions } from './skill-check/index.js';
export { checkExamples, type ExamplesOptions, type ExamplesReport } from './skill-check/examples.js';
export { SKILL_MAX_LINES, SKILL_SECTIONS, skillFormatIssues } from './skill-check/format.js';
export { codeBlocks, headings, proseOf, sectionText, type CodeBlock, type Heading } from './skill-check/markdown.js';
export { formatSkillIssue, type SkillIssue, type SkillSource } from './skill-check/source.js';
export { memoryMailGuard, type MailGuard, type MailGuardConfig } from './mail-guard.js';

/**
 * Load `DROBEK_MODULES` the way the server does at start (resolve, validate,
 * check the set: slots, requires, error codes) and return the modules in
 * that order. `importer` resolves a package name (`drobek-module-<name>` for
 * a short name) to the module's ES module, or null when it is not installed.
 */
export async function loadModules(env: { DROBEK_MODULES?: string }, opts: { importer: (specifier: string) => Promise<unknown> }): Promise<AnyModule[]> {
  return (await loadModuleSet({ DROBEK_MODULES: env.DROBEK_MODULES }, { importer: opts.importer, log: noopLogger })).modules;
}

/** The browser SDK the server builds from these modules: the bundle (`js`) and its declarations (`dts`). */
export interface TestSdkBundle {
  js: Buffer;
  dts: string;
}

/** Build the browser SDK (`/__drobek/sdk.js` + its `.d.ts`) from these modules, as the server does at start. */
export async function buildSdk(modules: AnyModule[]): Promise<TestSdkBundle> {
  const sdk = await buildServerSdk(modules);
  return { js: sdk.js, dts: sdk.dts };
}

/**
 * The folder of drobek's core migrations (journal `__drizzle_migrations_core`):
 * apply it before a module's own migrations, whose tables reference
 * `apps(id)`. The published package ships a copy (`dist/migrations/core`);
 * in the drobek repository it is `packages/db/drizzle/migrations`.
 */
export function coreMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'migrations/core'), join(here, '../migrations/core')]) {
    if (existsSync(join(candidate, 'meta/_journal.json'))) return candidate;
  }
  const db = dirname(createRequire(import.meta.url).resolve('@drobek/db'));
  return join(db, '../drizzle/migrations');
}

/**
 * A workspace + an app in a database with the core migrations applied — the
 * `app` to pass to createModuleTestContext (module rows reference its id).
 */
export async function createTestApp(db: unknown, opts: { slug?: string } = {}): Promise<HookApp> {
  const d = db as DB;
  const slug = opts.slug ?? `test-${Math.random().toString(36).slice(2, 10)}`;
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: `${slug}-ws`, name: slug }).returning();
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug }).returning();
  return { id: app.id, slug: app.slug, workspaceId: ws.id };
}

export interface ModuleTestOptions {
  /** A partial config (merged over configDefaults, then validated). */
  config?: Record<string, unknown>;
  /** The config once a pending change is confirmed (`ctx.pendingConfig`; partial, merged over configDefaults). Default: nothing pending. */
  pendingConfig?: Record<string, unknown>;
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
   * slot's schema would have parsed them; default: none — `[]`). A slot
   * host's `compose` runs with them first, as at server start.
   */
  contributions?: Record<string, unknown[]>;
  /** A job's `ctx.upstreams.fetch` (default: ModuleError `unavailable`, like a server without proxy). */
  upstreams?: (name: string, request: UpstreamRequest) => Promise<UpstreamResponse>;
  /** A job's `ctx.records.import` (default: ModuleError `unavailable`, like a server without data). */
  records?: (collection: string, records: Record<string, unknown>[], opts: RecordsImportOptions) => Promise<RecordsImportResult>;
}

/** One request to the module's `endUsers.callback` (the dashboard-host IdP callback). */
export interface TestCallbackInit {
  provider: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: Record<string, string> | null;
  /** Default `127.0.0.1`; `null` = no resolved client IP. */
  clientIp?: string | null;
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

export interface TestJobRunInit {
  /** Default: a signal that never aborts. */
  signal?: AbortSignal;
  /** `ctx.lastSuccessAt` (default null: the first run). */
  lastSuccessAt?: Date | null;
}

export interface TestJobRun {
  /** false: a `scope: 'app'` job whose `every(config, app)` gave no interval for the test app — core would not run it. */
  ran: boolean;
  /** The interval core would run it at for the test app (ms, clamped to 1 min – 30 days), or null. */
  intervalMs: number | null;
}

export interface TestResponse {
  status: number;
  /** A list-valued header is joined with `, ` (like fetch `Headers.get`). */
  headers: Record<string, string>;
  /** Every `Set-Cookie` value in order (like fetch `Headers.getSetCookie`). */
  setCookies: string[];
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
  /**
   * Run the module's `endUsers.callback` the way core runs it for
   * `/__drobek/auth/callback/:provider` on the dashboard host: the test app
   * is the only live app (`services.app(id)` answers it for its id, null for
   * any other), with the test config, secrets, limits and audits; the rate
   * limiter shares the test clock. Rejects when the module has no callback.
   */
  endUserCallback(init: TestCallbackInit): Promise<EndUserCallbackResult>;
  /**
   * Run the module's job `name` once, the way core's scheduler runs it: a
   * `scope: 'app'` job for the test app with the test config, secrets and
   * limits (not at all when `every(config, app)` gives no interval), a
   * `server` job with `apps()` yielding the test app. Rejects with the job's
   * own error, or when the module has no such job.
   */
  runJob(name: string, init?: TestJobRunInit): Promise<TestJobRun>;
  /** The module as the test runs it (composed from `contributions` when it hosts slots). */
  module: AnyModule;
}

function noDb(): DB {
  return new Proxy({} as DB, {
    get() {
      throw new Error('createModuleTestContext: pass `db` to use ctx.db in this test');
    },
  });
}

export function createModuleTestContext(declared: AnyModule, opts: ModuleTestOptions = {}): ModuleTestContext {
  const module = composeModule(declared, <T,>(slot: string) => [...(opts.contributions?.[slot] ?? [])] as T[]);
  const parsed = module.configSchema.safeParse(mergePatch(module.configDefaults, opts.config ?? {}));
  if (!parsed.success) {
    throw new Error(`createModuleTestContext: config does not pass ${module.name}.configSchema: ${parsed.error.message}`);
  }
  const config = parsed.data;
  let pendingConfig: unknown = null;
  if (opts.pendingConfig) {
    const p = module.configSchema.safeParse(mergePatch(module.configDefaults, opts.pendingConfig));
    if (!p.success) throw new Error(`createModuleTestContext: pendingConfig does not pass ${module.name}.configSchema: ${p.error.message}`);
    pendingConfig = p.data;
  }
  const origin = opts.origin ?? 'http://test--preview.apps.localhost';
  const app: HookApp = { id: 'app_test', slug: 'test', workspaceId: 'ws_test', ...opts.app };
  const limits: Limits = Object.freeze({
    ...Object.fromEntries((module.limits ?? []).map((l) => [l.env, l.default])),
    ...opts.limits,
  });
  const rateLimit = memoryRateLimiter(opts.now);
  const audits: ModuleTestContext['audits'] = [];
  const emails: ModuleTestContext['emails'] = [];
  const secretNames = new Set((module.secrets ?? []).map((s) => s.name));
  let principal: Principal = opts.principal ?? { kind: 'anon' };

  const buildCtx = (): ModuleContext<any> => ({
    app,
    module: module.name,
    principal,
    config,
    pendingConfig,
    db: opts.db ?? noDb(),
    log: opts.log ?? noopLogger,
    contributions: <T,>(slot: string) => [...(opts.contributions?.[slot] ?? [])] as T[],
    rules: { decide: (rule, ownerId) => decideAccess(rule, principal, ownerId) },
    limits: async () => limits,
    rateLimit: (bucket, key, max, windowMs) => rateLimit(`${bucket}:${key}`, max, windowMs),
    secrets: {
      get: async (name) => {
        if (!secretNames.has(name)) throw new Error(`module "${module.name}" reads undeclared secret "${name}"`);
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
    const headers: Record<string, string> = {};
    const setCookies: string[] = [];
    for (const [k, v] of Object.entries(r.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
      if (k.toLowerCase() === 'set-cookie') setCookies.push(...(Array.isArray(v) ? v : [v]));
    }
    return { status: r.status, headers, setCookies, body, bytes, bodyBytesRead };
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
    module,
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
    async endUserCallback(init) {
      const callback = module.endUsers?.callback?.bind(module.endUsers);
      if (!callback) throw new Error(`module "${module.name}" has no endUsers.callback`);
      const base = buildCtx();
      return callback({
        provider: init.provider,
        method: init.method ?? 'GET',
        query: { ...(init.query ?? {}) },
        body: init.body ?? null,
        clientIp: init.clientIp === undefined ? '127.0.0.1' : init.clientIp,
        services: {
          db: base.db,
          log: base.log,
          contributions: base.contributions,
          rateLimit: (bucket, key, max, windowMs) => rateLimit(`callback:${bucket}:${key}`, max, windowMs),
          limits: () => limits,
          app: async (appId) =>
            appId === app.id ? { app, config, limits: async () => limits, secrets: base.secrets, audit: base.audit, contributions: base.contributions } : null,
        },
      });
    },
    async runJob(name, init = {}) {
      const job = module.jobs?.find((j) => j.name === name);
      if (!job) throw new Error(`module "${module.name}" has no job "${name}"`);
      const base = buildCtx();
      const common = {
        db: base.db,
        log: base.log,
        contributions: base.contributions,
        module: module.name,
        job: job.name,
        signal: init.signal ?? new AbortController().signal,
        lastSuccessAt: init.lastSuccessAt ?? null,
        limits: async () => limits,
      };
      if (job.scope === 'app') {
        const every = typeof job.every === 'function' ? job.every(config, app) : job.every;
        const ms = every === null || every === undefined ? null : parseJobInterval(every);
        if (ms === null) return { ran: false, intervalMs: null };
        const ctx: AppJobContext<any> = {
          ...common,
          app,
          config,
          pendingConfig: pendingConfig ?? null,
          rateLimit: base.rateLimit,
          secrets: base.secrets,
          upstreams: {
            fetch: async (upstream, request = {}) => {
              if (!opts.upstreams) throw new ModuleError('unavailable', 'No module that calls upstreams (proxy) is on for this app\'s workspace.');
              return opts.upstreams(upstream, request);
            },
          },
          records: {
            import: async (collection, records, importOpts) => {
              if (!opts.records) throw new ModuleError('unavailable', 'No module that stores records and imports them in batches (data) is on for this app\'s workspace.');
              return opts.records(collection, records, importOpts);
            },
          },
          audit: base.audit,
        };
        await job.run(ctx);
        return { ran: true, intervalMs: Math.min(JOB_MAX_INTERVAL_MS, Math.max(JOB_MIN_INTERVAL_MS, ms)) };
      }
      const ctx: ServerJobContext<any> = {
        ...common,
        apps: async function* () {
          yield { app, config, db: base.db, log: base.log };
        },
      };
      await job.run(ctx);
      return { ran: true, intervalMs: parseJobInterval(job.every) };
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
