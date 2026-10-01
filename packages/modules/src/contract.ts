/**
 * The public TypeScript module contract of drobek — semver 1.x. A platform module is an npm package (a built-in under `modules/<name>`,
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
 * the agent-facing documentation `skill_info` returns. A module with no app
 * surface — only contributions to operator slots (`errors.reporter`,
 * `email.transport`), server jobs, hooks, limits, migrations — may leave the
 * skill out: it is operator-only, never shown to agents or app owners.
 *
 * Contract 1.1 adds `contract`, `errors`, typed `slots` (`contributes`,
 * `services.contributions()`), `availability`, `dashboard.editor` and
 * `hooks.onAppDelete`. Contract 1.2 adds `jobs` (scheduled work), a route
 * context's `pendingConfig`, and a per-app job context's `upstreams.fetch`,
 * `records.import` and audit. Every addition is optional, so an older module
 * loads unchanged.
 *
 * Everything a handler needs arrives in a per-request, APP-SCOPED
 * ModuleContext: the caller (principal from the `drobek_eu` end-user cookie),
 * the rule evaluator, limits, a rate limiter, this app's secrets for this
 * module, audit, the database and e-mail. A module never reads cookies itself
 * and never sees another app's id.
 */
import type { Readable } from 'node:stream';
import type { Logger } from '@drobek/core';
import type { DB } from '@drobek/db';
import type { ZodType } from 'zod';

/**
 * The contract version this package implements (the `DrobekModule` shape).
 * A module states the versions it works with in `contract` (a semver range,
 * e.g. `'^1.1'`); the server refuses to start a module whose range this
 * version does not satisfy.
 */
export const MODULE_CONTRACT_VERSION = '1.2.0';

/** Module names: lowercase, URL-, JS-property- and env-safe. */
export const MODULE_NAME_RE = /^[a-z][a-z0-9]{1,30}$/;

/** Error codes a module declares in `errors`: lowercase snake case, 3–41 characters. */
export const MODULE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{2,40}$/;

/** Job names: lowercase snake case, 2–40 characters, unique within the module. */
export const JOB_NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Slot names: `<host module name>.<camelCase name>`, e.g. `auth.provider`. */
export const SLOT_NAME_RE = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

// ── the caller ───────────────────────────────────────────────────────────────

/**
 * Who is calling a module route, resolved by core from the host-only
 * `drobek_eu` end-user session cookie of the app host. The platform
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
  /**
   * How the session signed in: `email` (the e-mail code) or an auth
   * provider's id. Absent = `email` (a session from before
   * providers existed). Never part of the principal a module sees.
   */
  provider?: string;
  /**
   * A provider session's connection: the end-user authority's fingerprint of
   * the provider's identity config when the session began (`auth` ends the
   * session once it differs). Never part of the principal a module sees.
   */
  connection?: string;
}

/**
 * An access rule: a `|`-separated disjunction of principals —
 * `public | user | owner | admin | none` (e.g. `"owner|admin"`). `owner`
 * matches a signed-in user whose id equals the record's owner.
 */
export type Rule = string;

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403 };

/** The operations a module exposes to rules, for the dashboard's rule editor. */
interface RuleSurface {
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

/** A limit the module enforces — its env name is the operator's knob. */
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
  /**
   * After the app was soft-deleted (the dashboard's delete; best effort — a
   * failure is logged). For clean-up outside the database cascade, e.g. data
   * the module keeps in another system.
   */
  onAppDelete?: (app: HookApp, services: ModuleServices) => Promise<void> | void;
}

/**
 * One error code a module's routes answer with (`{ error: code, … }`),
 * documented for agents: `skill_info('<name>').errors` and the module's
 * section of the error catalogue in `/llms-full.txt`. A route may answer only
 * the core codes (`CORE_ERROR_CODES`) and the codes its own module declares
 * here — any other code becomes `500 internal_error` (logged).
 */
export interface ModuleErrorDoc {
  /** `MODULE_ERROR_CODE_RE`; unique across the core catalogue and every active module. */
  code: string;
  /** What happened, for the agent (one or two sentences). */
  meaning: string;
  /** What to do about it. */
  fix: string;
}

/**
 * A typed extension point a module (the HOST) offers other modules: each
 * active module may contribute one value to it (`contributes`), validated
 * by `schema` at server start. The host reads them with
 * `services.contributions(slot)`, in `DROBEK_MODULES` order — at run time
 * only those of modules that are on for the app's workspace (an opt-in
 * module switched off there contributes nothing); `compose` sees them all.
 */
export interface ModuleSlot<T = unknown> {
  /** Validates every contribution; the host gets the parsed value. */
  schema: ZodType<T>;
  /**
   * A key of the contribution whose value must be unique within the slot
   * (e.g. `id`): two contributions with the same value refuse the start.
   */
  unique?: string;
  /** What a contribution does, for module authors and the dashboard. */
  description: string;
  /**
   * The contributions configure the server, not apps (e.g. where its errors
   * or its mail go): a module whose only contributions go to such slots may
   * leave out its skill (an operator-only module). Default false.
   */
  operatorOnly?: boolean;
}

/**
 * Who the module is for: `default` — every workspace of the server (the
 * behaviour without the field); `opt-in` — the workspaces it is enabled for.
 * The value is validated and reported (skill_info, the dashboard's module
 * view); core does not restrict a module by it.
 */
export type ModuleAvailability = 'default' | 'opt-in';

/** The dedicated dashboard editors a module's config can declare it fits. */
export type ModuleDashboardEditor = 'collections' | 'upstreams';

/** How the dashboard presents the module. */
export interface ModuleDashboard {
  /**
   * The dedicated dashboard editor this module's config fits (a capability
   * declaration, validated at start and reported in the dashboard's module
   * view): `collections` (a `collections` config shaped like the built-in
   * `data`'s) or `upstreams` (an `upstreams` config shaped like `proxy`'s).
   */
  editor?: ModuleDashboardEditor;
  /**
   * The module's name for people, e.g. `'Scheduled imports'`: the dashboard
   * shows "Scheduled imports (sync)". The module's `name` stays its
   * identifier everywhere (URLs, the config key, MCP, skill_info). One line,
   * at most 60 characters.
   */
  title?: string;
  /**
   * One line for the app's owner, shown in the dashboard under the title
   * instead of `skill.useWhen` (which is written for agents). At most 200
   * characters.
   */
  description?: string;
}

/**
 * Where the dashboard's config form takes the choices of a string field from
 * (the JSON Schema keyword `x-drobek-choices`, see ConfigFieldMeta):
 *
 *  - `upstreams` — the upstreams registered in the app's workspace, those
 *    assigned to the app first (the config of the module declaring
 *    `dashboard.editor: 'upstreams'`);
 *  - `collections` — the app's data collections (the config of the module
 *    declaring `dashboard.editor: 'collections'`);
 *  - `intervals` — intervals from 5 minutes to a day (`'5m'` … `'24h'`), none
 *    shorter than the module limit `x-drobek-min-interval` names.
 */
export type ConfigChoices = 'upstreams' | 'collections' | 'intervals';

/**
 * What the dashboard's config form reads from a field of a module's
 * `configSchema` — set with zod's `.meta()`, e.g.
 * `z.string().meta({ title: 'Upstream', 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta)`.
 * Presentation only: configure_module and the configSchema validate the
 * same with or without it, and a value outside the choices stays valid.
 */
export interface ConfigFieldMeta {
  /** The field's label (without one: the key, humanized). */
  title?: string;
  /** Shown under the field. */
  description?: string;
  /**
   * A string field becomes a select of these choices (see ConfigChoices). A
   * current value that is not among them stays selectable, marked; with no
   * choice at all the form says what to set up first, and where.
   */
  'x-drobek-choices'?: ConfigChoices;
  /**
   * With `'x-drobek-choices': 'intervals'`: the env name of one of the
   * module's `limits` that holds the shortest interval in minutes (the
   * workspace's value applies), e.g. `'SYNC_MIN_INTERVAL_MIN'`.
   */
  'x-drobek-min-interval'?: string;
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
  current(input: {
    app: HookApp;
    user: EndUser;
    config: Config;
    db: DB;
    log: Logger;
    /** The slot contributions of the modules that are on for the app's workspace (a disabled opt-in module contributes nothing). */
    contributions<T = unknown>(slot: string): T[];
  }): Promise<EndUser | null>;

  // ── the owner's view (the dashboard Users tab) — optional ──
  // Core calls these only after it authorized a drobek account for the app
  // (the workspace role; changes are editor+). Unknown user → null / a
  // ModuleError `not_found`.

  /** The app's end users, newest first (`search` = a case-insensitive part of the address). */
  list?(view: OwnerView<Config>, query: EndUserListQuery): Promise<EndUserPage>;
  /**
   * Make a user `user` or `admin`. When the role follows the app's config,
   * return the merge patch of THIS module's config that gives it (core applies
   * it under the config lock, in the same transaction as `view.db`, without a
   * confirmation — the owner is the one who confirms). The change applies to
   * the next module request (core asks `current` on every one). A role that
   * cannot be changed (e.g. a workspace editor is always admin) → ModuleError
   * `conflict`.
   */
  setRole?(view: OwnerView<Config>, id: string, role: 'user' | 'admin'): Promise<{ user: EndUserRecord; configPatch: Record<string, unknown> | null }>;
  /** Block (true) or unblock a user; a blocked user is anonymous — and signed out — on the next request. */
  setDisabled?(view: OwnerView<Config>, id: string, disabled: boolean): Promise<EndUserRecord | null>;

  /**
   * The IdP callback of the end-user sign-in providers: core routes
   * `GET|POST /__drobek/auth/callback/:provider` on the DASHBOARD host here —
   * the one redirect URI an IdP client registers for every app. No dashboard
   * session is read and no origin check applies (the IdP redirects or posts
   * the browser here): the authority must authenticate the request by its
   * own signed, single-use state, find the app from that state (never from
   * the request) and answer a redirect to the app host or a page. A throw is
   * logged and answers a generic error page.
   */
  callback?(input: EndUserCallbackInput<Config>): Promise<EndUserCallbackResult>;
}

/** One app as the end-user authority sees it in a sign-in callback (once it found the app in its own state). */
export interface EndUserCallbackApp<Config = unknown> {
  app: HookApp;
  /** The authority module's effective config for the app. */
  config: Config;
  /** Limits of the app's workspace. */
  limits(): Promise<Limits>;
  /** This app's secrets of the authority module (declared names only), plaintext in memory. */
  secrets: { get(name: string): Promise<string | null> };
  /** Append an audit row for this app (actor: the anonymous visitor; action prefixed with the module name). */
  audit(action: string, meta?: Record<string, unknown>): Promise<void>;
  /** The slot contributions of the modules that are on for the app's workspace (a disabled opt-in module contributes nothing). */
  contributions<T = unknown>(slot: string): T[];
}

/** What the end-user authority's `callback` gets. */
export interface EndUserCallbackInput<Config = unknown> {
  /** The `:provider` path segment as the request sent it (unvalidated). */
  provider: string;
  method: 'GET' | 'POST';
  /** Query parameters (first value of each). */
  query: Record<string, string>;
  /** The form fields of a POST (`application/x-www-form-urlencoded`, ≤ 256 KiB), else null. */
  body: Record<string, string> | null;
  clientIp: string | null;
  services: ModuleServices & {
    /** Fixed-window counter namespaced to the module's callback (no app is known yet). */
    rateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<RateLimitResult>;
    /** The server's default limits (env / catalogue defaults — no workspace is known yet). */
    limits(): Limits;
    /** A live app by id (not deleted, not taken down) with the authority's config for it, or null. */
    app(appId: string): Promise<EndUserCallbackApp<Config> | null>;
  };
}

/** The callback's answer: send the browser on (to the app host), or show a page on the dashboard host. */
export type EndUserCallbackResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'page'; status: number; title: string; message: string; link?: { href: string; label: string } };

/** One end user as the owner sees them. */
export interface EndUserRecord {
  id: string;
  email: string;
  /** The role they have NOW (what `current` would answer). */
  role: 'user' | 'admin';
  /** Why they are admin: `workspace` (an editor of the app's workspace — fixed), `config` (the module's config). */
  roleSource: 'workspace' | 'config' | null;
  /** `active`, `disabled` by the owner, or `not_allowed` any more by the config (signed out on their next request). */
  status: 'active' | 'disabled' | 'not_allowed';
  /** How the user signs in: `email` (the e-mail code) or the auth provider their account is linked to. */
  provider?: string;
  created_at: string;
  last_sign_in_at: string | null;
}

export interface EndUserListQuery {
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface EndUserPage {
  users: EndUserRecord[];
  /** Users matching the search (all pages). */
  total: number;
  next_cursor: string | null;
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
  /** Limits of the app's workspace (contract 1.2 — core always passes it; optional for 1.1 callers such as a module's own tests). */
  limits?(): Promise<Limits>;
}

/**
 * Who may confirm a pending change: `editor` (the default —
 * editors, workspace admins, super-admins) or `admin` (workspace admins and
 * super-admins only), e.g. a change that spends a secret an admin registered.
 */
export type ConfirmRole = 'editor' | 'admin';

/** One change that waits for the owner: its text, or the text + who may confirm it. */
export type ConfirmItem = string | { change: string; confirmRole?: ConfirmRole };

/** The texts of `items` and the role their confirmation needs (the highest any item asks for). */
export function normalizeConfirmItems(items: readonly unknown[]): { changes: string[]; role: ConfirmRole } {
  const changes: string[] = [];
  let role: ConfirmRole = 'editor';
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.length > 0) changes.push(item);
      continue;
    }
    if (item && typeof item === 'object' && typeof (item as { change?: unknown }).change === 'string') {
      const { change, confirmRole } = item as { change: string; confirmRole?: unknown };
      if (change.length === 0) continue;
      changes.push(change);
      if (confirmRole === 'admin') role = 'admin';
    }
  }
  return { changes, role };
}

/** What `onConfirmed` gets: the confirm transaction and who confirmed. */
export interface ConfirmedContext {
  app: HookApp;
  /** The confirm transaction (the config row is locked): writes commit with the confirmation. */
  db: DB;
  /** The dashboard user who confirmed. */
  userId: string;
  /** Their confirming role (`admin` = workspace admin or super-admin). */
  role: ConfirmRole;
  /**
   * Append an audit row for this app IN the confirm transaction (actor: the
   * confirming user; the action is prefixed with the module name, e.g.
   * `collection.purge` → `data.collection.purge`). `meta`: ids and counts only.
   */
  audit(action: string, meta?: Record<string, unknown>): Promise<void>;
}

// ── the records authority (data) ─────────────────────────────────────────────

/**
 * One app as a module's OWNER-facing authority sees it (records, end users,
 * submissions, files): core authorized a drobek account for the app first.
 * `config` is the module's effective config for the app, `db` the database —
 * or the transaction core runs the call in (a config change) — and `limits`
 * the app's workspace limits.
 */
export interface OwnerView<Config = unknown> {
  app: HookApp;
  config: Config;
  db: DB;
  log: Logger;
  limits(): Promise<Limits>;
}

/** The app a records call is about, with the records module's effective config for it. */
export type RecordsView<Config = unknown> = OwnerView<Config>;

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

  // ── owner edits (the dashboard Data tab, editor+) — optional ──

  /**
   * Replace a record's own fields (`_…` keys are ignored), validated like any
   * write (schema, the per-record and per-app quotas); `_owner` and
   * `_created_at` stay. null when the record does not exist. A bad record →
   * ModuleError `validation_failed` (details: the fields).
   */
  update?(view: RecordsView<Config>, collection: string, id: string, fields: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /**
   * Import CSV text into a collection as new records (no owner): the header
   * names the fields. All or nothing — ONE transaction; too many rows
   * (`RECORDS_IMPORT_MAX_ROWS`) is refused before anything is parsed further,
   * and the first invalid row is reported with its line number
   * (ModuleError `validation_failed`, `details.line`) with nothing stored.
   */
  importCsv?(view: RecordsView<Config>, collection: string, csv: string): Promise<{ imported: number }>;
  /**
   * Delete a collection: its records now (in `view.db`, core's config
   * transaction), and return the merge patch of the module's config that
   * removes its declaration (core writes it in the same transaction).
   */
  dropCollection?(view: RecordsView<Config>, collection: string): Promise<{ records: number; configPatch: Record<string, unknown> }>;
  /**
   * Collections that hold records but are not declared in the config any
   * more (orphans — e.g. a write that landed while its collection was being
   * removed), with their record counts. They still count towards the quotas.
   */
  orphans?(view: RecordsView<Config>): Promise<{ name: string; records: number }[]>;
  /**
   * Delete the records of an ORPHAN collection (in `view.db`, core's config
   * transaction). A collection the config declares → ModuleError `conflict`
   * (the owner deletes a declared one with dropCollection).
   */
  purgeOrphan?(view: RecordsView<Config>, collection: string): Promise<{ records: number }>;
  /**
   * Contract 1.2: write a batch of records into a declared
   * collection as a whole — ONE transaction, every record checked against
   * the collection's schema and the quotas first; any failure stores
   * nothing. `replace`: the collection holds exactly these records
   * afterwards; `upsert`: a record whose `key` field equals a stored
   * record's replaces that record's fields, the others are added, the rest
   * stay. Records have no owner. A bad record → ModuleError
   * `validation_failed` (`details.index` names it).
   */
  importRecords?(view: RecordsView<Config>, collection: string, records: Record<string, unknown>[], opts: RecordsImportOptions): Promise<RecordsImportResult>;
}

/** How `importRecords` writes a batch. */
export interface RecordsImportOptions {
  mode: 'replace' | 'upsert';
  /** The field that identifies a record (required for `upsert`; its values are strings or numbers, unique in the batch). */
  key?: string;
}

/** What `importRecords` changed. */
export interface RecordsImportResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** The most rows (without the header) one CSV import may carry. */
export const RECORDS_IMPORT_MAX_ROWS = 5000;

// ── the submissions authority (forms) ────────────────────────────────────────

export interface SubmissionsQuery {
  /** One form, or every form of the app. */
  form?: string;
  /** Submitted at or after (ISO timestamp). */
  from?: string;
  /** Submitted before (ISO timestamp, exclusive). */
  to?: string;
  limit?: number;
  cursor?: string | null;
}

/** A stored submission as the owner sees it. */
export interface OwnerSubmission {
  id: string;
  form: string;
  created_at: string;
  data: Record<string, unknown>;
  user_id: string | null;
  notified: boolean;
}

export interface SubmissionsPage {
  submissions: OwnerSubmission[];
  /** Submissions matching the filter (all pages). */
  total: number;
  next_cursor: string | null;
}

/**
 * The module that stores form submissions (the built-in `forms`) answers the
 * OWNER (the dashboard Forms tab): core calls it only after it authorized a
 * drobek account for the app. Bad filter/cursor → ModuleError `invalid_request`.
 */
export interface SubmissionsAuthority<Config = unknown> {
  /** The app's forms (declared or with stored submissions) and their submission counts. */
  forms(view: OwnerView<Config>): Promise<{ name: string; submissions: number }[]>;
  list(view: OwnerView<Config>, query: SubmissionsQuery): Promise<SubmissionsPage>;
  /** The CSV export (filter applied, newest first, capped): header line first, one line per submission. */
  csv(view: OwnerView<Config>, query: Omit<SubmissionsQuery, 'limit' | 'cursor'>): AsyncIterable<string>;
  /** Delete one submission; false when it did not exist. */
  remove(view: OwnerView<Config>, id: string): Promise<boolean>;
}

// ── the files authority (files) ──────────────────────────────────────────────

/** A stored upload as the owner sees it. */
export interface OwnerFile {
  id: string;
  name: string;
  /** The sniffed type (never the client's), e.g. `image/png`. */
  type: string;
  size: number;
  /** The uploader's end-user id, or null. */
  owner: string | null;
  created_at: string;
}

export interface OwnerFilesPage {
  files: OwnerFile[];
  next_cursor: string | null;
  used_bytes: number;
  quota_bytes: number;
}

/**
 * The module that stores end-user uploads (the built-in `files`) answers the
 * OWNER (the dashboard Uploads tab): list, the bytes (for a preview /
 * download core serves with `nosniff`), delete (the module's own rules for
 * the stored bytes, e.g. content shared by another app stays).
 */
export interface FilesAuthority<Config = unknown> {
  list(view: OwnerView<Config>, query: { limit?: number; cursor?: string | null }): Promise<OwnerFilesPage>;
  /** The file and its bytes, or null. The caller reads the stream once. */
  open(view: OwnerView<Config>, id: string): Promise<{ file: OwnerFile; stream: Readable } | null>;
  remove(view: OwnerView<Config>, id: string): Promise<boolean>;
}

// ── the upstreams authority (proxy) — contract 1.2 ──────────────────────────

/** One call a job makes to an upstream assigned to its app. */
export interface UpstreamRequest {
  /** Default `GET`. The upstream's allowed methods still apply. */
  method?: 'GET' | 'POST';
  /** Path (and `?query`) below the upstream's base URL; default `/`. Its allowed path prefixes still apply. */
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  /** A lower response cap than the operator's (never a higher one). */
  maxBytes?: number;
}

/** The upstream's answer (any status — check it). */
export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The module that owns the app's calls to its workspace's upstreams (the
 * built-in `proxy`) makes one for a module JOB (never for an app request):
 * the same checks as its route minus the caller's rule — the upstream is
 * assigned to the app in `view.config` and confirmed for it, the secret is
 * injected server-side, the SSRF guard, the allow-lists and the size cap
 * apply. A refusal → ModuleError (`forbidden`, `not_found`, `upstream_error`,
 * `ssrf_blocked`, `proxy_busy`, …) with a secret-free message.
 */
export interface UpstreamsAuthority<Config = unknown> {
  fetch(view: OwnerView<Config>, name: string, request: UpstreamRequest): Promise<UpstreamResponse>;
}

// ── the sync authority (sync) — contract 1.2 ────────────────────────────────

/** One source of the module that imports data on a schedule, as the owner sees it. */
export interface SyncSourceState {
  name: string;
  upstream: string;
  path: string;
  collection: string;
  mode: 'replace' | 'upsert';
  /** The interval in force (the config's, raised to the operator's minimum). */
  every: string;
  /**
   * Why it does not run on schedule: `owner` (the config says `paused: true`),
   * `failures` (too many failed runs in a row), `limit` (past the app's source
   * limit), or null.
   */
  paused: 'owner' | 'failures' | 'limit' | null;
  /** Failed runs since the last success. */
  failures: number;
  last_run_at: string | null;
  last_status: 'ok' | 'failed' | null;
  last_records: number | null;
  last_error: string | null;
  last_success_at: string | null;
  /** When the next scheduled run is due (null while paused). */
  next_run_at: string | null;
}

/** One run of a source (newest first in `runs`). */
export interface SyncRun {
  source: string;
  trigger: 'schedule' | 'manual';
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'failed';
  /** Records the collection holds from this run (ok), null when it failed. */
  records: number | null;
  inserted?: number;
  updated?: number;
  deleted?: number;
  /** Why it failed (secret-free), null when ok. */
  error: string | null;
}

/**
 * The module that imports data into the app on a schedule (the built-in
 * `sync`) answers the OWNER — the dashboard and MCP (`sync_now`, get_logs
 * `sync`): core calls it only after it authorized a drobek account for the
 * app. Unknown source → ModuleError `not_found`.
 */
export interface SyncAuthority<Config = unknown> {
  sources(view: OwnerView<Config>): Promise<SyncSourceState[]>;
  /** The latest runs (newest first; `source` narrows, `since` bounds, at most `limit`, ≤ 100). */
  runs(view: OwnerView<Config>, query: { source?: string; since?: Date; limit?: number }): Promise<SyncRun[]>;
  /** Run one source now (a paused one too); `ctx` is a per-app job context whose audit names the person. */
  runNow(ctx: AppJobContext<Config>, source: string): Promise<SyncRun>;
  /** Clear a pause after failures (the next run is due at once); false when it was not paused so. */
  resume(view: OwnerView<Config>, source: string): Promise<boolean>;
}

// ── per-app info (get_app / configure_module) ────────────────────────────────

/** One app as a module sees it outside a request: its effective config + services. */
export interface ModuleAppView<Config = unknown> {
  app: HookApp;
  config: Config;
  db: DB;
  log: Logger;
}

// ── scheduled jobs (contract 1.2) ───────────────────────────────────────────

/**
 * How often a job runs: milliseconds, or a whole count with a unit — `'30s'`,
 * `'5m'`, `'1h'`, `'1d'`. Between JOB_MIN_INTERVAL_MS (1 minute) and
 * JOB_MAX_INTERVAL_MS (30 days).
 */
export type JobInterval = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

/** What every job run gets. */
export interface JobContextBase extends ModuleServices {
  module: string;
  /** The job's name. */
  job: string;
  /**
   * Aborted when the run exceeds the operator's MODULE_JOBS_TIMEOUT_MS or the
   * server shuts down: pass it to `fetch` and stop early. A run that ignores
   * it counts as failed at the timeout all the same.
   */
  signal: AbortSignal;
  /** When the last successful run of this job (for this app) started, or null. */
  lastSuccessAt: Date | null;
}

/** What a `scope: 'server'` job gets: the module's apps to iterate and the server-wide limits. */
export interface ServerJobContext<Config = unknown> extends JobContextBase {
  /** The server's default limits (env / catalogue defaults — no workspace is known). */
  limits(): Promise<Limits>;
  /**
   * The live apps (not deleted, not taken down) that have a stored config of
   * this module and whose workspace has it on, each with its effective
   * config. Stop early by leaving the loop.
   */
  apps(): AsyncIterable<ModuleAppView<Config>>;
}

/** What a `scope: 'app'` job gets — scoped to ONE app, like a route's ModuleContext without a caller. */
export interface AppJobContext<Config = unknown> extends JobContextBase {
  app: HookApp;
  /** This app's effective config. */
  config: Config;
  /** The config once the owner confirms its pending change, or null. Never act on it: it is not in force. */
  pendingConfig: Config | null;
  /** Limits of this app's workspace. */
  limits(): Promise<Limits>;
  /** Fixed-window counter namespaced to this module + app (the same buckets its routes use). */
  rateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<RateLimitResult>;
  secrets: {
    /** The plaintext of this app's declared secret `name` for this module, or null. */
    get(name: string): Promise<string | null>;
  };
  /**
   * Call an upstream assigned to THIS app (the proxy config, a
   * workspace admin confirmed it) through the module that declares
   * `upstreams` — the secret is injected server-side, never seen here.
   * ModuleError `unavailable` when no such module is on for the workspace.
   */
  upstreams: {
    fetch(name: string, request?: UpstreamRequest): Promise<UpstreamResponse>;
  };
  /**
   * Write a batch of records into one of THIS app's declared
   * collections through the records authority (`importRecords`: all or
   * nothing, schema + quotas checked). ModuleError `unavailable` when the
   * records module cannot.
   */
  records: {
    import(collection: string, records: Record<string, unknown>[], opts: RecordsImportOptions): Promise<RecordsImportResult>;
  };
  /**
   * Append an audit row for this app (the action is prefixed with the module
   * name). A scheduled run has no person behind it: actor kind `user` without
   * a user (the Activity page shows "system"), `meta.by: 'schedule'`; a run a
   * person started (the sync authority's `runNow`) names them.
   */
  audit(action: string, meta?: Record<string, unknown>): Promise<void>;
}

/** A job core runs once per interval for the whole server (one replica at a time). */
export interface ServerJob<Config = unknown> {
  /** `JOB_NAME_RE`, unique within the module. */
  name: string;
  /** One line for operators and agents (skill_info). */
  description?: string;
  scope?: 'server';
  every: JobInterval;
  run(ctx: ServerJobContext<Config>): Promise<void> | void;
}

/**
 * A job core runs for EACH app that has a stored config of the module and
 * the module on for its workspace, each app on its own interval — fixed, or
 * read from the app's config (`every(config, app)`; null or undefined = not
 * for this app now).
 */
export interface AppJob<Config = unknown> {
  /** `JOB_NAME_RE`, unique within the module. */
  name: string;
  /** One line for operators and agents (skill_info). */
  description?: string;
  scope: 'app';
  every: JobInterval | ((config: Config, app: HookApp) => JobInterval | null | undefined);
  run(ctx: AppJobContext<Config>): Promise<void> | void;
}

/**
 * Scheduled work of a module (contract 1.2). Core runs each job on its
 * interval under a Redis lease (once across replicas), at most
 * MODULE_JOBS_CONCURRENCY runs per process, each cut off at
 * MODULE_JOBS_TIMEOUT_MS. A failed run is logged (a per-app job's also in the
 * app's get_logs `runtime`) and retried with backoff; it never affects the
 * server's start or its requests. A job is the module's own trusted code —
 * the server still never runs app code.
 */
export type ModuleJob<Config = unknown> = ServerJob<Config> | AppJob<Config>;

const INTERVAL_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** The shortest interval a job runs at. */
export const JOB_MIN_INTERVAL_MS = 60_000;
/** The longest interval a job runs at. */
export const JOB_MAX_INTERVAL_MS = 30 * 86_400_000;

/**
 * A JobInterval in milliseconds, or null when the value is not one (a number
 * that is not a positive integer, any other string). Not range-checked — see
 * JOB_MIN_INTERVAL_MS / JOB_MAX_INTERVAL_MS.
 */
export function parseJobInterval(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const m = INTERVAL_RE.exec(value.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

// ── the module ───────────────────────────────────────────────────────────────

export interface DrobekModule<Config = unknown> {
  /** `/__drobek/v1/<name>`, `drobek.<name>`, the config key and the skill name. */
  name: string;
  /** The module's own semver. */
  version: string;
  /**
   * The contract versions this module works with: a semver range matched
   * against `MODULE_CONTRACT_VERSION` (e.g. `'^1.1'`). Not satisfied → the
   * server refuses to start; missing → a start-up warning.
   */
  contract?: string;
  /** The agent-facing documentation (skill_info, the briefing). A module without one is an OperatorModule. */
  skill: ModuleSkill;
  /**
   * Per-app configuration (zod). Validates every configure_module call and
   * the dashboard form (JSON Schema via `z.toJSONSchema`). Keep secrets OUT.
   */
  configSchema: ZodType<Config>;
  /** The configuration of an app nobody configured (must pass configSchema). */
  configDefaults: Config;
  /**
   * Optional: the usable part of a STORED config that no longer passes
   * configSchema as a whole (a legacy import, a hand edit, a lowered cap).
   * Gets the merged config (defaults + stored) and returns the config to
   * serve with plus one line per part it dropped or could not fix (logged
   * once per stored content), or null to fall back to `configDefaults` — the
   * behaviour without it. configure_module still validates the WHOLE config,
   * so the next change has to repair it. E.g. data keeps every valid
   * collection instead of answering 404 for all of them.
   */
  salvageConfig?(merged: unknown): { config: Config; issues: string[] } | null;
  /**
   * The changes between two VALID configs that need the owner's confirmation
   * in the dashboard — e.g. an operation opened to `public`, a new e-mail
   * recipient. Non-empty → configure_module stores the change as pending.
   * Each string is shown to the owner and the agent verbatim. `context` names
   * the app and gives read access to the database (inside the configure
   * transaction), for rules that depend on stored data — e.g. removing the
   * schema of a collection that holds records. An item may be
   * `{ change, confirmRole: 'admin' }`: only a workspace admin can confirm
   * the pending change then (editors may still reject it).
   */
  confirmRequired?(before: Config, after: Config, context: ConfirmContext): ConfirmItem[] | Promise<ConfirmItem[]>;
  /**
   * Runs INSIDE the confirm transaction once the owner confirmed a pending
   * change (`before` / `after` = the effective configs). A throw rolls the
   * confirmation back. E.g. proxy records the app on the upstream's allow-list.
   */
  onConfirmed?(before: Config, after: Config, context: ConfirmedContext): void | Promise<void>;
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
  /** Only the module that stores form submissions (forms): the owner's view for the dashboard. */
  submissions?: SubmissionsAuthority<Config>;
  /** Only the module that stores end-user uploads (files): the owner's view for the dashboard. */
  files?: FilesAuthority<Config>;
  /** Contract 1.2 — only the module that owns the app's upstream calls (proxy): a module job's `ctx.upstreams.fetch`. */
  upstreams?: UpstreamsAuthority<Config>;
  /** Contract 1.2 — only the module that imports data on a schedule (sync): the owner's view for the dashboard and MCP. */
  sync?: SyncAuthority<Config>;
  /**
   * Secret-free facts about this module's state for ONE app, shown to the
   * app's agents: get_app's `modules.<name>.info` and configure_module's
   * `info` (after the change). E.g. the proxy module lists the workspace
   * upstreams the config points at with `hasSecret` — NEVER a secret value,
   * never another app's data. A throw is logged and the `info` left out.
   */
  appInfo?(view: ModuleAppView<Config>): Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Other modules this one needs (by name), e.g. `forms` requires `email`.
   * The server refuses to start when one of them is not in DROBEK_MODULES.
   */
  requires?: string[];
  /**
   * The module's own error codes (beyond the core catalogue) with their
   * meaning and fix — see ModuleErrorDoc.
   */
  errors?: ModuleErrorDoc[];
  /**
   * Extension points this module offers other modules, by slot name
   * (`<this module's name>.<name>`, e.g. `auth.provider`) — see ModuleSlot.
   */
  slots?: Record<string, ModuleSlot>;
  /**
   * This module's contribution to other modules' slots, by slot name
   * (e.g. `{ 'auth.provider': { id: 'oidc', … } }`). The slot must belong to
   * an active module and the value must pass its schema.
   */
  contributes?: Record<string, unknown>;
  /**
   * Optional, for a slot HOST whose config or secrets depend on what other
   * modules contribute (e.g. `auth` adds `providers.<id>` and the providers'
   * secrets for each `auth.provider` contribution). Called once at start,
   * after the contributions were checked and before
   * `DROBEK_MODULE_<NAME>_DEFAULTS` is applied; the parts it returns replace
   * the declared ones everywhere (configure_module, the dashboard, skill_info,
   * the test kit). The composed `configDefaults` must pass the composed
   * `configSchema`. A throw refuses the start.
   */
  compose?(input: ModuleComposeInput): ComposedModuleParts<Config>;
  /** Who the module is for (default `default`: every workspace) — see ModuleAvailability. */
  availability?: ModuleAvailability;
  /** How the dashboard presents the module. */
  dashboard?: ModuleDashboard;
  /**
   * Scheduled jobs (contract 1.2) — see ModuleJob. A module with jobs
   * declares `contract: '^1.2'`: a 1.1 server ignores the field.
   */
  jobs?: ModuleJob<Config>[];
}

/**
 * A module without a skill: operator-only. Allowed only with no app surface —
 * no routes, sdk, app config (configSchema fields, salvageConfig,
 * confirmRequired, onConfirmed), secrets, rules, errors, owner authority,
 * appInfo, opt-in availability, dashboard.editor, `scope: 'app'` job, compose
 * or slot that is not `operatorOnly` — and with contributions to
 * `operatorOnly` slots only (`errors.reporter`, `email.transport`); the
 * registry refuses anything else at start. It is left out of skill_info, the
 * briefing, llms.txt, configure_module and the app's Modules tab;
 * /api/version and the super-admin's workspace Modules page mark it
 * `operatorOnly`.
 */
export interface OperatorModule<Config = unknown> extends Omit<DrobekModule<Config>, 'skill'> {
  skill?: undefined;
}

/** A module of any config type, with or without a skill (what the registry holds). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModule = DrobekModule<any> | OperatorModule<any>;

const BRAND = Symbol.for('drobek.module');

/** What a slot host's `compose` gets at start: the checked contributions to every slot. */
export interface ModuleComposeInput {
  contributions<T = unknown>(slot: string): T[];
}

/** The parts of a module its `compose` may replace (the rest of the module stays as declared). */
export type ComposedModuleParts<Config = unknown> = Partial<
  Pick<DrobekModule<Config>, 'configSchema' | 'configDefaults' | 'salvageConfig' | 'confirmRequired' | 'secrets'>
>;

/** Declare a module (typed identity + a brand the registry checks): with a skill a DrobekModule, without one an OperatorModule. */
export function defineModule<Config>(module: DrobekModule<Config>): DrobekModule<Config>;
export function defineModule<Config>(module: OperatorModule<Config>): OperatorModule<Config>;
export function defineModule<Config>(module: DrobekModule<Config> | OperatorModule<Config>): DrobekModule<Config> | OperatorModule<Config>;
export function defineModule<Config>(module: DrobekModule<Config> | OperatorModule<Config>): DrobekModule<Config> | OperatorModule<Config> {
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

/** Who an e-mail may go to — never an arbitrary address. */
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
   * combined with another recipient). Only the module that owns end-user
   * sessions (`endUsers`) may use it; any other module gets `forbidden`.
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
  /**
   * The contributions of the active modules to `slot` (a slot THIS module
   * declares, or any other active module's), in `DROBEK_MODULES` order, as
   * the slot's schema parsed them; [] when nobody contributes. In a route,
   * `endUsers.current` and the create / publish hooks: only the modules that
   * are on for the app's workspace (an opt-in module switched off there
   * contributes nothing); with no app known (the end-user callback before
   * `app()`): only the default modules; in `onAppDelete`: every active
   * module. Type it with the slot's value type:
   * `contributions<Provider>('auth.provider')`.
   */
  contributions<T = unknown>(slot: string): T[];
}

/** Everything a route handler gets — scoped to ONE app and ONE module. */
export interface ModuleContext<Config = unknown> extends ModuleServices {
  app: HookApp;
  module: string;
  principal: Principal;
  /** This app's effective config (defaults + what was set). */
  config: Config;
  /**
   * The config this app would have once the owner confirms its pending
   * change; null or absent when nothing waits (or it no longer validates).
   * Never act on it: it is not in force. It lets a route answer honestly
   * about something the agent configured but the owner has not confirmed.
   */
  pendingConfig?: Config | null;
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
     * `limit_exceeded` (the app's e-mail limits), `unavailable` (e-mail of
     * this class — sign-in codes or notifications — is paused by the
     * operator-wide hourly budget, the app used its hourly share of
     * notifications, or no mail module is active).
     */
    send(message: EmailMessage): Promise<{ sent: number }>;
    /**
     * Sign-in codes (`{ signInAddress }`) this app may send per hour under the
     * operator-wide budget (EMAIL_SIGNIN_APP_HOURLY_SHARE of the sign-in
     * budget) — a module's own per-app cap must not exceed it.
     * Undefined when core runs no e-mail guard (tests).
     */
    signInShare?: number;
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

export interface ModuleRequest<Body = unknown, Query = Record<string, string>> {
  method: string;
  /** Path below `/__drobek/v1/<module>`, always starting with `/`. */
  path: string;
  /**
   * `:name` segments of the route pattern (percent-decoded). A trailing `*`
   * segment captures the rest of the path in `params['*']` — RAW
   * (percent-encoded, no leading slash, '' when nothing follows).
   */
  params: Record<string, string>;
  /** Query parameters (validated when the route declares `query`). */
  query: Query;
  /** The raw query string, without `?` ('' when none) — repeated keys and encoding intact. */
  rawQuery: string;
  /** Parsed JSON body (validated when the route declares `body`). */
  body: Body;
  header(name: string): string | null;
  /** Every request header (lower-cased names; repeated ones joined with `, `). */
  headers(): Record<string, string>;
  clientIp: string | null;
  /**
   * The ONE file of a `bodyTypes: ['file']` route (multipart/form-data),
   * streamed — never buffered by the router. Rejects with a ModuleError
   * (`unsupported_media_type`, `invalid_request`) when the body is not such a
   * multipart body; throws on any other route. Call it once.
   */
  file(): Promise<UploadedFile>;
}

/** The file part of a multipart upload (`req.file()`). Everything but `stream` is client-supplied: never trust it. */
export interface UploadedFile {
  /** The multipart field name of the file part. */
  field: string;
  /** The client's file name ('' when none) — untrusted. */
  filename: string;
  /** The Content-Type the client declared for the part, or null — untrusted (sniff the bytes). */
  declaredType: string | null;
  /** Text fields sent BEFORE the file part (a field after it is refused). */
  fields: Record<string, string>;
  /**
   * The file's bytes as they arrive. Read it once. The route caps the size
   * itself: stop early by leaving the loop (`break`/`throw`) — the rest of the
   * request is then discarded without being buffered. Iteration throws a
   * ModuleError `invalid_request` on a malformed body (no closing boundary, a
   * second part) and an Error when the client aborts.
   */
  stream: AsyncIterable<Buffer>;
}

/** A non-JSON-200 answer: `respond(status, body, headers)`. */
export interface ModuleResponse {
  readonly __drobekResponse: true;
  status: number;
  /** JSON-serialisable value, a string/Buffer sent as-is, or a Node `Readable` streamed as-is (e.g. a file). */
  body: unknown;
  /** A list value sends the header once per item (e.g. several `Set-Cookie`). */
  headers: Record<string, string | string[]>;
}

export function respond(status: number, body: unknown = null, headers: Record<string, string | string[]> = {}): ModuleResponse {
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
  /**
   * What the counter keys on (default `ip`; `principal` = the signed-in user,
   * the IP for an anonymous caller). A request without a resolved client IP
   * skips an IP-keyed limit — no shared bucket.
   */
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
   * refused (415). `raw` = any content type, unparsed: the body is the
   * `Buffer` (undefined when empty) and `body` validation is skipped — for
   * pass-through routes (the proxy). Anything else is
   * `415 unsupported_media_type`.
   * `file` = `multipart/form-data` carrying ONE file: the router does not read
   * the body (and `maxBodyBytes` does not apply) — the handler streams it with
   * `req.file()` and MUST cap its size itself. Exclusive: a `file` route takes
   * no JSON body.
   */
  bodyTypes?: Array<'json' | 'multipart' | 'raw' | 'file'>;
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
