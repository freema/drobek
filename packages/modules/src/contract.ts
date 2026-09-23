/**
 * The public TypeScript module contract of drobek (M1-01, NSO-287) — semver
 * 1.x. A platform module is an npm package (a built-in under `modules/<name>`,
 * a third-party one named `drobek-module-<name>`) whose default export is the
 * result of `defineModule()`. The OPERATOR installs modules and lists them in
 * `DROBEK_MODULES`; they are trusted server-side dependencies of the same
 * class as Express. An app author (or agent) never uploads one — the server
 * still never runs app code.
 *
 * A module contributes: routes on every app host under
 * `/__drobek/v1/<name>/…` (ModuleRouter), a piece of the browser SDK
 * (`drobek.<name>` in `/__drobek/sdk.js`), a per-app configuration validated by
 * `configSchema` (set by agents through `configure_module`, risky changes held
 * for the owner's confirmation by `confirmRequired`), the names of the secrets
 * it can use (values only ever entered in the dashboard), limits, and a SKILL:
 * the agent-facing documentation `skill_info` returns.
 *
 * Everything a handler needs arrives in a per-request, APP-SCOPED
 * ModuleContext: the caller (principal from the `drobek_eu` end-user cookie),
 * the rule evaluator, limits, a rate limiter, this app's secrets for this
 * module, audit, the database and e-mail. A module never reads cookies itself
 * and never sees another app's id.
 */
import type { Logger } from '@drobek/core';
import type { DB } from '@drobek/db';
import type { ZodType } from 'zod';

/** The contract version this package implements (the `DrobekModule` shape). */
export const MODULE_CONTRACT_VERSION = '1.0.0';

/** Module names: lowercase, URL-, JS-property- and env-safe. */
export const MODULE_NAME_RE = /^[a-z][a-z0-9]{1,30}$/;

// ── the caller ───────────────────────────────────────────────────────────────

/**
 * Who is calling a module route, resolved by core from the host-only
 * `drobek_eu` end-user session cookie of the app host (§5.0):
 *  - `anon` — no (valid) session;
 *  - `user` — an end user signed in to THIS app; `role: 'admin'` marks the
 *    app's administrators (the owner signs in with their e-mail and is admin).
 * The dashboard session is never read on an app host.
 */
export type Principal =
  | { kind: 'anon' }
  | { kind: 'user'; id: string; email: string; role: 'user' | 'admin' };

/**
 * An access rule: a `|`-separated disjunction of principals —
 * `public | user | owner | admin | none` (e.g. `"owner|admin"`). `owner`
 * matches a signed-in user whose id equals the record's owner.
 */
export type Rule = string;

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403 };

/** The operations a module exposes to rules, for the dashboard's rule editor. */
export interface RuleSurface {
  /** operation → one-line meaning, e.g. `{ read: 'List and get records' }`. */
  ops: Record<string, string>;
}

// ── documentation ────────────────────────────────────────────────────────────

/**
 * The agent-facing skill (returned by `skill_info('<name>')`). Short
 * Markdown, target ≤ 150 lines: when to use → minimal working code → the exact
 * SDK calls and their types → limits and server-enforced rules → common
 * errors and fixes. No marketing.
 */
export interface ModuleSkill {
  /**
   * ONE sentence starting with the situation, listed by `skill_info()`,
   * create_app and get_app — e.g. "the user submits something and you want to
   * store it or get it by e-mail".
   */
  useWhen: string;
  /** The skill body (Markdown). */
  markdown: string;
}

/** A limit the module enforces — its env name is the operator's knob (§5.7). */
export interface ModuleLimit {
  /** Env var name, e.g. `FORMS_PER_APP_PER_DAY` (UPPER_SNAKE). */
  env: string;
  /** Default when neither the env nor the limits provider sets it. */
  default: number;
  meaning: string;
}

/** A secret the module can use (the value is entered in the dashboard only). */
export interface ModuleSecretDoc {
  /** UPPER_SNAKE name, e.g. `OPENAI_API_KEY`. */
  name: string;
  description: string;
  /** true → configure_module reports it in `secrets_missing` until it is set. */
  required?: boolean;
}

/** The browser part of a module. */
export interface ModuleSdk {
  /**
   * Absolute path (or `file:` URL) of an ES module whose DEFAULT export is
   * `(core: SdkCore) => Api` (SdkCore from `@drobek/sdk`). Bundled into
   * `/__drobek/sdk.js` as `drobek.<name>` by esbuild at server start; https://
   * imports stay external, anything else is bundled.
   */
  entry: string;
  /**
   * TypeScript declarations for `drobek.<name>`: MUST declare an
   * `interface Api` (plus any helper types). Wrapped in
   * `declare namespace <name> { … }` in `/__drobek/sdk.d.ts`.
   */
  types: string;
}

/** Module-owned tables: a drizzle migrations folder with its own journal. */
export interface ModuleMigrations {
  /** Absolute path (or `file:` URL) of the drizzle migrations folder. */
  folder: string;
}

/** Which app a hook runs for. */
export interface HookApp {
  id: string;
  slug: string;
  workspaceId: string;
}

export interface ModuleHooks {
  /** After create_app stored version 1 (best effort — a failure is logged). */
  onAppCreate?: (app: HookApp, services: ModuleServices) => Promise<void> | void;
  /** After a version was published (MCP publish or the dashboard). */
  onPublish?: (app: HookApp & { version: number }, services: ModuleServices) => Promise<void> | void;
}

// ── the module ───────────────────────────────────────────────────────────────

export interface DrobekModule<Config = unknown> {
  /** `/__drobek/v1/<name>`, `drobek.<name>`, the config key and the skill name. */
  name: string;
  /** The module's own semver. */
  version: string;
  skill: ModuleSkill;
  /**
   * Per-app configuration (zod). Validates every configure_module call and
   * the dashboard form (JSON Schema via `z.toJSONSchema`). Keep secrets OUT.
   */
  configSchema: ZodType<Config>;
  /** The configuration of an app nobody configured (must pass configSchema). */
  configDefaults: Config;
  /**
   * The changes between two VALID configs that need the owner's confirmation
   * in the dashboard — e.g. an operation opened to `public`, a new e-mail
   * recipient. Non-empty → configure_module stores the change as pending.
   * Each string is shown to the owner and the agent verbatim.
   */
  confirmRequired?(before: Config, after: Config): string[];
  secrets?: ModuleSecretDoc[];
  rules?: RuleSurface;
  limits?: ModuleLimit[];
  /** Register the HTTP routes (called once at startup). */
  routes?(r: ModuleRouter<Config>): void;
  sdk?: ModuleSdk;
  migrations?: ModuleMigrations;
  hooks?: ModuleHooks;
}

/** A module of any config type (what the registry holds). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModule = DrobekModule<any>;

const BRAND = Symbol.for('drobek.module');

/** Declare a module (typed identity + a brand the registry checks). */
export function defineModule<Config>(module: DrobekModule<Config>): DrobekModule<Config> {
  return Object.freeze({ ...module, [BRAND]: MODULE_CONTRACT_VERSION });
}

/** Was `value` produced by defineModule()? */
export function isDefinedModule(value: unknown): value is DrobekModule {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] !== undefined;
}

// ── services a handler gets ──────────────────────────────────────────────────

/** Limits for one workspace: env name → value (env default, or the limits provider). */
export type Limits = Readonly<Record<string, number>>;

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (a hint for Retry-After). */
  retryAfterSec: number;
}

/** Who an e-mail may go to — never an arbitrary address (§5.4). */
export type EmailRecipient =
  /** The addresses at this dotted path of THIS module's app config (owner-confirmed). */
  | { config: string }
  /** The signed-in end user making the request (their verified e-mail). */
  | { principal: true };

export interface EmailMessage {
  to: EmailRecipient;
  subject: string;
  /** Plain text; the server wraps it in the drobek layout (escaped). */
  text: string;
}

/** App-independent services (hooks, startup). */
export interface ModuleServices {
  db: DB;
  log: Logger;
}

/** Everything a route handler gets — scoped to ONE app and ONE module. */
export interface ModuleContext<Config = unknown> extends ModuleServices {
  app: HookApp;
  module: string;
  principal: Principal;
  /** This app's effective config (defaults + what was set). */
  config: Config;
  rules: {
    /** Evaluate `rule` for the caller; `ownerId` = the record's owner (for `owner`). */
    decide(rule: Rule, ownerId?: string | null): AccessDecision;
  };
  /** Limits of this app's workspace (env defaults or the limits provider). */
  limits(): Promise<Limits>;
  /** Fixed-window counter, namespaced to this module + app: `bucket` × `key`. */
  rateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  secrets: {
    /** The plaintext of this app's secret `name` for this module (in memory only), or null. */
    get(name: string): Promise<string | null>;
  };
  /** Append an audit row for this app (actor derived by the server). */
  audit(action: string, meta?: Record<string, unknown>): Promise<void>;
  email: {
    send(message: EmailMessage): Promise<{ sent: number }>;
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

export interface ModuleRequest<Body = unknown, Query = Record<string, string>> {
  method: string;
  /** Path below `/__drobek/v1/<module>`, always starting with `/`. */
  path: string;
  /** `:name` segments of the route pattern. */
  params: Record<string, string>;
  /** Query parameters (validated when the route declares `query`). */
  query: Query;
  /** Parsed JSON body (validated when the route declares `body`). */
  body: Body;
  header(name: string): string | null;
  clientIp: string | null;
}

/** A non-JSON-200 answer: `respond(status, body, headers)`. */
export interface ModuleResponse {
  readonly __drobekResponse: true;
  status: number;
  /** JSON-serialisable value, or a string/Buffer sent as-is. */
  body: unknown;
  headers: Record<string, string>;
}

export function respond(status: number, body: unknown = null, headers: Record<string, string> = {}): ModuleResponse {
  return { __drobekResponse: true, status, body, headers };
}

export type RouteHandler<Config, Body, Query> = (
  req: ModuleRequest<Body, Query>,
  ctx: ModuleContext<Config>
) => Promise<unknown> | unknown;

export interface RouteRateLimit {
  /** Bucket name (namespaced by core to the module + app). */
  bucket: string;
  /** Max calls per window: a number, or the env name of one of the module's limits. */
  max: number | string;
  windowMs: number;
  /** What the counter keys on (default `ip`). */
  per?: 'ip' | 'app' | 'principal';
}

export interface RouteOptions<Config = unknown, Body = unknown, Query = Record<string, string>> {
  /** Validates the JSON body (400 `invalid_request` with field paths otherwise). */
  body?: ZodType<Body>;
  /** Validates the query parameters (strings). */
  query?: ZodType<Query>;
  /** Access rule for the caller — fixed, or derived from the app's config. */
  rule?: Rule | ((config: Config) => Rule);
  rateLimit?: RouteRateLimit;
  /** Max request body (default 32 KiB). */
  maxBodyBytes?: number;
  /**
   * CSRF guard for mutating methods (POST/PUT/PATCH/DELETE). Always: an
   * `Origin` header, when present, must be the app host itself. Default
   * `sdk-header` additionally requires `X-Drobek-SDK: 1` (the SDK sends it; a
   * cross-site form or fetch cannot without a CORS preflight the apps origin
   * never grants). `same-origin` drops the header requirement — only for
   * endpoints a browser calls without custom headers (e.g. navigator.sendBeacon).
   */
  csrf?: 'sdk-header' | 'same-origin';
}

export interface ModuleRouter<Config = unknown> {
  get<Q = Record<string, string>>(path: string, opts: RouteOptions<Config, undefined, Q>, handler: RouteHandler<Config, undefined, Q>): void;
  get(path: string, handler: RouteHandler<Config, undefined, Record<string, string>>): void;
  post<B = unknown, Q = Record<string, string>>(path: string, opts: RouteOptions<Config, B, Q>, handler: RouteHandler<Config, B, Q>): void;
  post(path: string, handler: RouteHandler<Config, unknown, Record<string, string>>): void;
  put<B = unknown, Q = Record<string, string>>(path: string, opts: RouteOptions<Config, B, Q>, handler: RouteHandler<Config, B, Q>): void;
  put(path: string, handler: RouteHandler<Config, unknown, Record<string, string>>): void;
  patch<B = unknown, Q = Record<string, string>>(path: string, opts: RouteOptions<Config, B, Q>, handler: RouteHandler<Config, B, Q>): void;
  patch(path: string, handler: RouteHandler<Config, unknown, Record<string, string>>): void;
  delete<Q = Record<string, string>>(path: string, opts: RouteOptions<Config, undefined, Q>, handler: RouteHandler<Config, undefined, Q>): void;
  delete(path: string, handler: RouteHandler<Config, undefined, Record<string, string>>): void;
}
