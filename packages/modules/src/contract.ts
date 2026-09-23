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
 * `drobek_eu` end-user session cookie of the app host (§5.0). The platform
 * module `auth` signs end users in (e-mail code):
 *  - `anon` — no (valid) session;
 *  - `user` — an end user signed in to THIS app; `role: 'admin'` marks the
 *    app's administrators (the auth config's `adminEmails`, and the editors
 *    of the app's workspace signing in with their own e-mail).
 * The dashboard session is never read on an app host.
 */
export type Principal =
  | { kind: 'anon' }
  | { kind: 'user'; id: string; email: string; role: 'user' | 'admin' };

/** A signed-in end user (the `user` principal without its tag). */
export interface EndUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

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
  /**
   * Optional source module an app imports as `drobek/<name>` (e.g. React
   * components such as the auth module's `<LoginGate>`). Unlike `entry` it is
   * NOT in `/__drobek/sdk.js`: the compiler builds it INTO the app bundle, so
   * its bare imports (`react`, …) resolve through the app's own `drobek.json`
   * — the app and the component share one React — and `drobek` resolves to
   * the SDK. One self-contained `.ts`/`.tsx` file (no relative imports),
   * read from the operator's disk at server start.
   */
  inline?: {
    /** Absolute path (or `file:` URL) of the `.ts`/`.tsx` source. */
    entry: string;
    /** Its declarations (shown by skill_info and in `/__drobek/sdk.d.ts`). */
    types: string;
  };
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

/**
 * The module that OWNS end-user sessions (the built-in `auth`): core asks it
 * about the user of every live session before any module route sees a
 * principal, so a user who was disabled, deleted or removed from the
 * allowlist is anonymous — and their session deleted — on the very next
 * request to ANY module, and a role follows the app's config at once. At most
 * one active module may declare it; without one, no session is honoured.
 */
export interface EndUserAuthority<Config = unknown> {
  /**
   * The user of a live session of `app` as they are NOW (their current role),
   * or null: not allowed any more → core ends the session. Called once per
   * module request that carries a session; keep it to indexed lookups. A throw
   * makes that request anonymous (fail closed) without ending the session.
   */
  current(input: { app: HookApp; user: EndUser; config: Config; db: DB; log: Logger }): Promise<EndUser | null>;
}

/** What an e-mail is for (the module that owns app e-mail treats them differently). */
export type EmailKind =
  /** A one-time sign-in code (`{ signInAddress }`) — the auth module. */
  | 'sign_in'
  /** Everything else: form notifications, notifyAdmins, a message to the signed-in user. */
  | 'notification';

/** What core hands the mail authority for every message of any module of an app. */
export interface MailPrepareInput<Config = unknown> {
  app: HookApp;
  /** The module that sends (e.g. `forms`). */
  module: string;
  kind: EmailKind;
  /** How many addresses the message resolved to (≥ 1). */
  recipients: number;
  /** The MAIL module's own effective config for this app. */
  config: Config;
  /** Limits of the app's workspace. */
  limits: Limits;
  /** Fixed-window counter namespaced to the MAIL module + this app. */
  rateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  log: Logger;
}

/** Envelope details the mail authority adds to a message. */
export interface MailEnvelope {
  /** Display name of the sender (the address is always the operator's EMAIL_FROM). */
  fromName?: string;
  /** A Reply-To address. */
  replyTo?: string;
}

/**
 * The module that owns app e-mail (the built-in `email`): core calls
 * `prepare` for EVERY `ctx.email.send` of any module, after the recipients
 * resolved and before anything is sent. It enforces the per-app policy (a
 * `limit_exceeded` ModuleError refuses the message) and returns the
 * envelope. At most one active module may declare it. Without one, only
 * sign-in codes can be sent; any other message is `unavailable`.
 */
export interface MailAuthority<Config = unknown> {
  prepare(input: MailPrepareInput<Config>): Promise<MailEnvelope>;
}

/** What `confirmRequired` gets besides the two configs. */
export interface ConfirmContext {
  app: HookApp;
  /** Read-only use: the configure transaction (the config row is locked). */
  db: DB;
}

// ── the records authority (data) ─────────────────────────────────────────────

/** The app a records call is about, with the records module's effective config for it. */
export interface RecordsView<Config = unknown> {
  app: HookApp;
  config: Config;
  db: DB;
  log: Logger;
}

/** One collection as the owner sees it. */
export interface RecordsCollection {
  name: string;
  /** operation → rule, e.g. `{ read: 'public', create: 'admin', … }`. */
  rules: Record<string, string>;
  /** The collection's JSON Schema, or null (schemaless). */
  schema: unknown;
  /** Display columns from the schema: required properties first. [] without a schema. */
  columns: { key: string; required: boolean }[];
  /** Stored records. */
  records: number;
}

export interface RecordsQuery {
  collection: string;
  /** The records filter (`{ field: value }` or `{ field: { op: value } }`, see the module's skill). */
  filter?: unknown;
  /** A sort field (a schema property or `_id` / `_created_at` / `_updated_at`). */
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string | null;
}

/** A page of records: every record is `{ _id, _owner, _created_at, _updated_at, …fields }`. */
export interface RecordsPage {
  collection: RecordsCollection;
  records: Record<string, unknown>[];
  /** Records matching the filter (all pages). */
  total: number;
  next_cursor: string | null;
}

/**
 * The module that stores records (the built-in `data`) answers the OWNER's
 * questions about an app's data, bypassing the end-user rules: core calls it
 * only after it authorized a drobek account for the app (MCP membership, the
 * dashboard's workspace role). Unknown collection → ModuleError `not_found`;
 * a bad filter/sort → `invalid_request`.
 */
export interface RecordsAuthority<Config = unknown> {
  collections(view: RecordsView<Config>): Promise<RecordsCollection[]>;
  query(view: RecordsView<Config>, query: RecordsQuery): Promise<RecordsPage>;
  get(view: RecordsView<Config>, collection: string, id: string): Promise<Record<string, unknown> | null>;
  /** Delete one record (the dashboard, editor+); false when it did not exist. */
  remove(view: RecordsView<Config>, collection: string, id: string): Promise<boolean>;
  /** The CSV export of a collection (filter + sort applied): the header line, then one line per record (no line breaks). */
  csv(view: RecordsView<Config>, query: Omit<RecordsQuery, 'limit' | 'cursor'>): AsyncIterable<string>;
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
   * Each string is shown to the owner and the agent verbatim. `context` names
   * the app and gives read access to the database (inside the configure
   * transaction), for rules that depend on stored data — e.g. removing the
   * schema of a collection that holds records.
   */
  confirmRequired?(before: Config, after: Config, context: ConfirmContext): string[] | Promise<string[]>;
  secrets?: ModuleSecretDoc[];
  rules?: RuleSurface;
  limits?: ModuleLimit[];
  /** Register the HTTP routes (called once at startup). */
  routes?(r: ModuleRouter<Config>): void;
  sdk?: ModuleSdk;
  migrations?: ModuleMigrations;
  hooks?: ModuleHooks;
  /** Only the module that creates end-user sessions (auth). */
  endUsers?: EndUserAuthority<Config>;
  /** Only the module that owns app e-mail (email): per-app limits + the envelope of every module e-mail. */
  mail?: MailAuthority<Config>;
  /**
   * Only the module that stores the app's records (data): the owner's
   * read-mostly view for core — MCP `query_data` and the dashboard's data
   * browser. Never called for an app host request.
   */
  records?: RecordsAuthority<Config>;
  /**
   * Other modules this one needs (by name), e.g. `forms` requires `email`.
   * The server refuses to start when one of them is not in DROBEK_MODULES.
   */
  requires?: string[];
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
  /** Calls counted in the current window, this one included. */
  count: number;
  /** Seconds until the window resets (a hint for Retry-After). */
  retryAfterSec: number;
}

/** Who an e-mail may go to — never an arbitrary address (§5.4). */
export type EmailRecipient =
  /** The addresses at this dotted path of THIS module's app config (owner-confirmed). */
  | { config: string }
  /** The signed-in end user making the request (their verified e-mail). */
  | { principal: true }
  /**
   * The app's owners: the editors and workspace-admins of the app's workspace
   * (verified drobek accounts; membership is managed by people in the
   * dashboard, never by an agent).
   */
  | { appOwners: true }
  /**
   * The ONE address someone is signing in with — the one-time code of the
   * auth module, sent only after the address passed the app's owner-confirmed
   * allowlist and the sign-in rate limits. Not for anything else (and never
   * combined with another recipient).
   */
  | { signInAddress: string };

export interface EmailMessage {
  /** One recipient reference or several (de-duplicated; every address gets its own message). */
  to: EmailRecipient | EmailRecipient[];
  /** One line: control characters (CR/LF, …) become spaces, max 200 characters. */
  subject: string;
  /** Plain text (max 20 000 characters); the server wraps it in the drobek layout (escaped). */
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
    /**
     * Send to allowed recipients only (never an arbitrary address). Resolves
     * `{ sent }` (0 when no address resolved). Rejects with a ModuleError:
     * `limit_exceeded` (the app's e-mail limits), `unavailable` (e-mail is
     * paused by the operator-wide hourly cap, or no mail module is active).
     */
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
   * Accepted body formats (default `['json']`). `multipart` =
   * `multipart/form-data` with text fields only: the body becomes
   * `{ name: value }` (a repeated name → an array of values); a file part is
   * refused (415). Anything else is `415 unsupported_media_type`.
   */
  bodyTypes?: Array<'json' | 'multipart'>;
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
