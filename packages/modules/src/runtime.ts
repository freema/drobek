/**
 * The module runtime of ONE server process (M1-01): the active modules, their
 * route tables, the composed SDK and the skill registry — plus the operations
 * the rest of drobek calls:
 *
 *  - `handle()` — every `/__drobek/*` request on an app host (after the app
 *    and its visibility gate were resolved by @drobek/serving): the SDK, the
 *    beacon script, and the module routes — each response of an active
 *    module is counted in `module_request_stats` (M1-07, get_logs requests);
 *  - `skillList()` / `skillInfo()` — the `skill_info` tool, create_app, get_app;
 *  - `configure()` / `confirm()` / `reject()` — configure_module and the
 *    dashboard's pending-change API;
 *  - `appModules()` — get_app's `modules` (configured, pending, hasSecret, the
 *    module's secret-free `info`);
 *  - `compileHint()` — the skill an `unresolved_import` should point at;
 *  - `runHook()` — onAppCreate / onPublish.
 *
 * `moduleRuntime()` is the process-wide instance, loaded once from
 * `DROBEK_MODULES` (memoised on globalThis, so the dev server's Vite-loaded
 * route modules share the instance the server entry created).
 */
import { appsOrigin, dashboardOrigin } from '@drobek/apps';
import { AUDIT_ACTIONS, actorKindForSurface, writeAudit } from '@drobek/audit';
import { renderTextEmailHtml, sendEmail } from '@drobek/email';
import { scanForSecrets } from '@drobek/compile';
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import { apps, getDb, memberships, runJournalMigrations, users, type DB } from '@drobek/db';
import { recordModuleRequest } from '@drobek/insights';
import { and, eq, inArray } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { normalizeConfirmItems } from './contract.js';
import type {
  AnyModule,
  ConfirmRole,
  EmailMessage,
  EndUser,
  EndUserListQuery,
  EndUserPage,
  EndUserRecord,
  HookApp,
  OwnerFile,
  OwnerFilesPage,
  OwnerView,
  SubmissionsPage,
  SubmissionsQuery,
  Limits,
  MailEnvelope,
  ModuleContext,
  Principal,
  RateLimitResult,
  RecordsCollection,
  RecordsPage,
  RecordsQuery,
  RecordsView,
} from './contract.js';
import { readConfigRow, readConfigRows, withLockedConfig, type PendingChange } from './configs.server.js';
import { capEmailText, emailKind, redactAddresses, resolveRecipients, sanitizeSubject } from './email.js';
import { ModuleError, isModuleError, issuePaths, skillHint } from './errors.js';
import { createLimitsProvider, type LimitsProvider } from './limits.js';
import { mailGuardConfigFromEnv, redisMailGuard, type MailGuard, type MailGuardRedis } from './mail-guard.js';
import { Lru, jsonKey } from './memo.js';
import { jsonEqual, mergePatch } from './merge-patch.js';
import { cookiePrincipalResolver, endUserCookiesSecure, type PrincipalResolver } from './principal.js';
import {
  ModuleLoadError,
  checkRequires,
  endUserAuthorityOf,
  filesAuthorityOf,
  loadModules,
  mailAuthorityOf,
  recordsAuthorityOf,
  submissionsAuthorityOf,
  type ResolveOptions,
} from './registry.js';
import { collectRoutes, errorResult, isReadable, matchRoute, runRoute, type PipelineRequest, type PipelineResult, type Route } from './router.js';
import { decideAccess } from './rules.js';
import { BEACON_SCRIPT_PATH, SDK_PATH, SDK_TYPES_PATH, buildSdk, moduleTypes, toPath, type SdkBundle } from './sdk-build.js';
import { PENDING_MAIL_WINDOW_MS, pendingMail, pendingMailKey } from './pending-mail.js';
import { getModuleSecret, secretsSet, secretsStatus } from './secrets.server.js';
import { generalSkillsDir, loadGeneralSkills, mergeSkills, moduleSkills, skillForImport, type SkillEntry } from './skills.js';

// ── deps ─────────────────────────────────────────────────────────────────────

export type RateLimiter = (key: string, max: number, windowMs: number) => Promise<RateLimitResult>;

/** One outgoing message to ONE address (recipients never see each other). */
export interface TransportMessage extends MailEnvelope {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  send(message: TransportMessage): Promise<void>;
}

export interface RuntimeDeps {
  env: NodeJS.ProcessEnv;
  log: Logger;
  db: () => DB;
  limits: LimitsProvider;
  principal: PrincipalResolver;
  rateLimit: RateLimiter;
  email: EmailTransport;
  /** The operator-wide hourly cap on module e-mail (auto-pause). */
  mailGuard: MailGuard;
  /**
   * Count one response of an ACTIVE module's route (M1-07 — get_logs
   * `requests`). Best-effort: never awaited by the response, errors dropped.
   */
  requestStats?: (appId: string, module: string, status: number) => Promise<void> | void;
}

type RedisLike = ReturnType<typeof getRedis>;

/** Fixed-window counter in Redis (atomic INCR + PEXPIRE), `drobek:rl:` keys. */
export function redisRateLimiter(redis: () => Pick<RedisLike, 'incr' | 'pexpire' | 'ttl'>): RateLimiter {
  return async (key, max, windowMs) => {
    const r = redis();
    const k = `drobek:rl:${key}`;
    const n = await r.incr(k);
    if (n === 1) await r.pexpire(k, windowMs);
    if (n <= max) return { ok: true, count: n, retryAfterSec: 0 };
    const ttl = await r.ttl(k);
    if (ttl < 0) await r.pexpire(k, windowMs); // a key that lost its expiry must not lock forever
    return { ok: false, count: n, retryAfterSec: Math.max(1, ttl > 0 ? ttl : Math.ceil(windowMs / 1000)) };
  };
}

/** In-process fixed-window counter (tests; `now` is the clock seam). */
export function memoryRateLimiter(now: () => number = Date.now): RateLimiter & { reset(): void } {
  const windows = new Map<string, { n: number; resetAt: number }>();
  const fn = (async (key: string, max: number, windowMs: number) => {
    const t = now();
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { n: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.n += 1;
    return w.n <= max
      ? { ok: true, count: w.n, retryAfterSec: 0 }
      : { ok: false, count: w.n, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
  }) as RateLimiter & { reset(): void };
  fn.reset = () => windows.clear();
  return fn;
}

/** Plain-text mail through the operator's SMTP (@drobek/email — the transport of the login codes too). */
export function smtpEmailTransport(log: Logger, env: NodeJS.ProcessEnv = process.env): EmailTransport {
  return {
    async send({ to, subject, text, fromName, replyTo }) {
      const html = renderTextEmailHtml({
        subject,
        text,
        footNote: 'Sent by an app hosted on drobek. You get it because this address is configured for the app, or you are signed in to it or own it.',
      });
      const r = await sendEmail({ to, subject, text, html, fromName, replyTo }, env);
      if (r === 'not_configured') log.info('module e-mail not sent (SMTP not configured in dev)', { subject });
    },
  };
}

/** The addresses of an app's owners: the editors and workspace-admins of its workspace. */
export async function appOwnerEmails(db: DB, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, ['editor', 'workspace-admin'])));
  return rows.map((r) => r.email);
}

// ── shapes ───────────────────────────────────────────────────────────────────

/** What serving hands over for a `/__drobek/*` request. */
export interface PlatformRequest extends PipelineRequest {}

/** The app behind the host (resolved + visibility-gated by @drobek/serving). */
export interface PlatformApp {
  id: string;
  slug: string;
  workspaceId: string;
}

export interface SkillListItem {
  name: string;
  use_when: string;
}

export interface SkillInfo {
  name: string;
  kind: 'module' | 'general';
  use_when: string;
  content: string;
  sdk?: { import: string; types: string; inline?: { import: string; types: string } };
  config?: { schema: unknown; defaults: unknown; confirm_required: string };
  limits?: { name: string; value: number; meaning: string }[];
  secrets?: { name: string; description: string; required: boolean }[];
}

export interface AppModuleState {
  configured: boolean;
  config: unknown;
  pending: boolean;
  pending_confirmation?: string[];
  /** Only a workspace admin can confirm the pending change (absent: any editor). */
  confirm_role?: 'admin';
  confirm_url?: string;
  secrets?: { name: string; hasSecret: boolean }[];
  /** The module's `appInfo` (secret-free), when it declares one. */
  info?: Record<string, unknown>;
}

export interface ConfigureInput {
  app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
  module: string;
  patch: unknown;
  /** The dashboard user whose agent calls (audit + pending.proposed_by). */
  actorUserId: string;
  /**
   * Who changes the config: `mcp` (default — configure_module, audit actor
   * `agent`, the owners get the pending-change e-mail) or `web` (the owner's
   * own dashboard form, audit actor `user`, no e-mail: they are looking at it).
   */
  surface?: 'mcp' | 'web';
}

export interface ConfigureResult {
  module: string;
  applied: boolean;
  /** The effective config now in force. */
  config: unknown;
  /** Changes waiting for the owner ([] when nothing waits). */
  pending_confirmation: string[];
  /** Only a workspace admin can confirm the pending change (absent: any editor). */
  confirm_role?: 'admin';
  confirm_url?: string;
  secrets_missing?: string[];
  unchanged?: true;
  /** The module's `appInfo` for the config now in force (secret-free), when it declares one. */
  info?: Record<string, unknown>;
}

/** The records store of one app (the module that declares `records`, bound to the app's config). */
export interface BoundRecords {
  /** The module that stores the records (e.g. `data`). */
  module: string;
  collections(): Promise<RecordsCollection[]>;
  query(query: RecordsQuery): Promise<RecordsPage>;
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;
  remove(collection: string, id: string): Promise<boolean>;
  csv(query: Omit<RecordsQuery, 'limit' | 'cursor'>): AsyncIterable<string>;
  /** Replace a record's fields (owner edit); null when it does not exist. `unavailable` when the module cannot. */
  update(collection: string, id: string, fields: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** All-or-nothing CSV import (see RecordsAuthority.importCsv). */
  importCsv(collection: string, csv: string): Promise<{ imported: number }>;
  /**
   * Delete a collection: its records and its declaration in the module's
   * config, in ONE transaction under the config lock; audited
   * `data.collection_delete` (actor user).
   */
  dropCollection(collection: string, actorUserId: string): Promise<{ records: number }>;
}

/** The end users of one app (the module that declares `endUsers`, bound to the app's config). */
export interface BoundEndUsers {
  module: string;
  list(query: EndUserListQuery): Promise<EndUserPage>;
  /** Change a role; a config change is applied under the config lock and audited `end_users.role` (actor user). */
  setRole(id: string, role: 'user' | 'admin', actorUserId: string): Promise<EndUserRecord>;
  setDisabled(id: string, disabled: boolean): Promise<EndUserRecord | null>;
}

/** The form submissions of one app (the module that declares `submissions`). */
export interface BoundSubmissions {
  module: string;
  forms(): Promise<{ name: string; submissions: number }[]>;
  list(query: SubmissionsQuery): Promise<SubmissionsPage>;
  csv(query: Omit<SubmissionsQuery, 'limit' | 'cursor'>): AsyncIterable<string>;
  remove(id: string): Promise<boolean>;
}

/** The end-user uploads of one app (the module that declares `files`). */
export interface BoundFiles {
  module: string;
  list(query: { limit?: number; cursor?: string | null }): Promise<OwnerFilesPage>;
  open(id: string): Promise<{ file: OwnerFile; stream: Readable } | null>;
  remove(id: string): Promise<boolean>;
}

/** A pending change as the dashboard shows it (M2-02). */
export interface PendingView {
  /** What needs confirming, verbatim from the module's confirmRequired. */
  changes: string[];
  proposed_at: string;
  proposed_by: string | null;
  /** Who may confirm it: any editor, or only a workspace admin (NSO-322 H3). */
  confirm_role: ConfirmRole;
  /** The effective config once confirmed (null when it no longer validates). */
  after: unknown;
  /** Why confirming would fail now (the pending change no longer fits the config). */
  invalid?: { path: string; message: string }[];
}

/** One module of one app, for the owner's dashboard (never a secret value). */
export interface ModuleDashboardView {
  name: string;
  version: string;
  use_when: string;
  /** The config's JSON Schema (zod → JSON Schema, input side), null when not representable. */
  schema: unknown;
  defaults: unknown;
  /** What was set (sparse merge patch over the defaults). */
  stored: Record<string, unknown>;
  /** The effective config in force. */
  config: unknown;
  pending: PendingView | null;
  /** Declared secrets: names, docs and whether/when they are set — never a value. */
  secrets: { name: string; description: string; required: boolean; hasSecret: boolean; updated_at: string | null }[];
  /** The operations the module's rules cover (module.rules.ops). */
  ops: Record<string, string>;
  /** Whether some changes of this module wait for the owner (it declares confirmRequired). */
  confirms: boolean;
  /** The module's secret-free appInfo. */
  info?: Record<string, unknown>;
}

export interface DecisionInput {
  app: { id: string; slug: string; workspaceId: string };
  module: string;
  userId: string;
  /**
   * The decider's role in the app's workspace: `admin` = workspace admin or
   * super-admin. Default `editor` — a change that needs an admin is refused.
   */
  role?: ConfirmRole;
}

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate';
const V1_RE = /^\/__drobek\/v1\/([^/]+)(\/.*)?$/;

/** The dashboard page where the owner confirms a module change (M2-02 serves it). */
export function confirmUrl(env: NodeJS.ProcessEnv, workspaceSlug: string, appSlug: string, module: string): string {
  return `${dashboardOrigin(env)}/workspaces/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}/modules/${encodeURIComponent(module)}`;
}

/** An optional owner-facing authority method the active module does not implement. */
function unsupported(module: string, what: string): ModuleError {
  return new ModuleError('unavailable', `The ${module} module on this server does not support ${what}.`);
}

// ── the runtime ──────────────────────────────────────────────────────────────

/** Distinct (module, stored config) pairs kept parsed in memory. */
const EFFECTIVE_CONFIG_MEMO_ENTRIES = 2000;

export class ModuleRuntime {
  readonly modules: AnyModule[];
  readonly skills: SkillEntry[];
  readonly sdk: SdkBundle;
  readonly deps: RuntimeDeps;
  private readonly routes = new Map<string, Route[]>();
  private readonly byName = new Map<string, AnyModule>();
  /**
   * Effective configs by (module, content of the stored config) — NSO-322 H1:
   * every module request used to re-run configSchema.safeParse (for data: an
   * ajv compile per collection). Keyed on the stored JSON itself, so a
   * configure / confirm (or a write by another process) is a new key and can
   * never serve a stale config.
   */
  private readonly configMemo = new Lru<{ value: unknown }>(EFFECTIVE_CONFIG_MEMO_ENTRIES);

  constructor(input: { modules: AnyModule[]; skills: SkillEntry[]; sdk: SdkBundle; deps: RuntimeDeps }) {
    this.modules = input.modules;
    this.skills = input.skills;
    this.sdk = input.sdk;
    this.deps = input.deps;
    for (const m of input.modules) {
      this.byName.set(m.name, m);
      try {
        this.routes.set(m.name, collectRoutes(m.routes?.bind(m) as never));
      } catch (err) {
        throw new ModuleLoadError(`module "${m.name}": ${(err as Error).message}`);
      }
    }
  }

  get(name: string): AnyModule | undefined {
    return this.byName.get(name);
  }

  // ── end users ──

  /**
   * Who the user of a live session of `app` is NOW, according to the module
   * that owns end-user sessions (its `endUsers.current` with this app's
   * effective config) — null when no active module owns sessions, or the user
   * may not be signed in any more.
   */
  async currentEndUser(app: HookApp, user: EndUser): Promise<EndUser | null> {
    const m = endUserAuthorityOf(this.modules);
    if (!m?.endUsers) return null;
    const db = this.deps.db();
    const row = await readConfigRow(app.id, m.name, db);
    const config = this.effectiveConfig(m, row.config);
    return m.endUsers.current({ app, user, config, db, log: this.deps.log });
  }

  // ── records ──

  /**
   * The app's records store (the module that declares `records`, e.g. data),
   * bound to the app's effective config — null when no active module stores
   * records. For the OWNER's view (query_data, the dashboard): the caller has
   * authorized a drobek account for the app already.
   */
  async records(app: HookApp): Promise<BoundRecords | null> {
    const m = recordsAuthorityOf(this.modules);
    if (!m?.records) return null;
    const db = this.deps.db();
    const row = await readConfigRow(app.id, m.name, db);
    const view: RecordsView = this.ownerView(app, this.effectiveConfig(m, row.config), db);
    const r = m.records;
    return {
      module: m.name,
      collections: () => r.collections(view),
      query: (q) => r.query(view, q),
      get: (collection, id) => r.get(view, collection, id),
      remove: (collection, id) => r.remove(view, collection, id),
      csv: (q) => r.csv(view, q),
      update: async (collection, id, fields) => {
        if (!r.update) throw unsupported(m.name, 'editing records');
        return r.update(view, collection, id, fields);
      },
      importCsv: async (collection, csv) => {
        if (!r.importCsv) throw unsupported(m.name, 'importing CSV');
        return r.importCsv(view, collection, csv);
      },
      dropCollection: async (collection, actorUserId) => {
        const drop = r.dropCollection?.bind(r);
        if (!drop) throw unsupported(m.name, 'deleting collections');
        return this.ownerConfigChange(m, app, actorUserId, async (config, tx) => {
          const out = await drop(this.ownerView(app, config, tx), collection);
          return {
            patch: out.configPatch,
            result: { records: out.records },
            audit: { action: AUDIT_ACTIONS.dataCollectionDelete, meta: { module: m.name, collection, records: out.records } },
          };
        });
      },
    };
  }

  /** The OwnerView of `app` for an owner-facing authority (limits of the app's workspace, loaded once). */
  private ownerView<C>(app: HookApp, config: C, db: DB): OwnerView<C> {
    let limits: Promise<Limits> | null = null;
    return { app, config, db, log: this.deps.log, limits: () => (limits ??= this.deps.limits.forWorkspace(app.workspaceId)) };
  }

  /**
   * An OWNER's change of module `m`'s config for `app` (the dashboard, never
   * an agent): under the config lock, `fn` gets the effective config and the
   * transaction, does its own writes in it and returns a merge patch (or
   * null); the patched config must pass configSchema. No confirmation: the
   * owner is the one who confirms. A pending agent change stays pending.
   */
  private async ownerConfigChange<T>(
    m: AnyModule,
    app: HookApp,
    actorUserId: string,
    fn: (config: unknown, tx: DB) => Promise<{ patch: Record<string, unknown> | null; result: T; audit: { action: string; meta: Record<string, unknown> } }>
  ): Promise<T> {
    return withLockedConfig(app.id, m.name, async (row, write, tx) => {
      const db = tx as unknown as DB;
      const out = await fn(this.effectiveConfig(m, row.config), db);
      if (out.patch) {
        const nextStored = mergePatch(row.config, out.patch) as Record<string, unknown>;
        this.validateConfig(m, mergePatch(m.configDefaults, nextStored));
        if (!jsonEqual(nextStored, row.config)) await write({ config: nextStored });
      }
      await writeAudit(
        {
          workspaceId: app.workspaceId,
          actorUserId,
          actorKind: actorKindForSurface('web'),
          action: out.audit.action,
          subjectType: 'app',
          target: app.slug,
          meta: out.audit.meta,
        },
        tx
      );
      return out.result;
    });
  }

  // ── end users (the owner's view) ──

  /** The app's end users (the module that declares `endUsers`), or null. */
  async endUsers(app: HookApp): Promise<BoundEndUsers | null> {
    const m = endUserAuthorityOf(this.modules);
    if (!m?.endUsers) return null;
    const db = this.deps.db();
    const row = await readConfigRow(app.id, m.name, db);
    const view = this.ownerView(app, this.effectiveConfig(m, row.config), db);
    const a = m.endUsers;
    return {
      module: m.name,
      list: async (q) => {
        if (!a.list) throw unsupported(m.name, 'listing end users');
        return a.list(view, q);
      },
      setRole: async (id, role, actorUserId) => {
        const setRole = a.setRole?.bind(a);
        if (!setRole) throw unsupported(m.name, 'changing roles');
        return this.ownerConfigChange(m, app, actorUserId, async (config, tx) => {
          const out = await setRole(this.ownerView(app, config, tx), id, role);
          return { patch: out.configPatch, result: out.user, audit: { action: AUDIT_ACTIONS.endUserRole, meta: { module: m.name, end_user: id, role } } };
        });
      },
      setDisabled: async (id, disabled) => {
        if (!a.setDisabled) throw unsupported(m.name, 'blocking users');
        return a.setDisabled(view, id, disabled);
      },
    };
  }

  // ── submissions / files (the owner's view) ──

  /** The app's form submissions (the module that declares `submissions`), or null. */
  async submissions(app: HookApp): Promise<BoundSubmissions | null> {
    const m = submissionsAuthorityOf(this.modules);
    if (!m?.submissions) return null;
    const db = this.deps.db();
    const row = await readConfigRow(app.id, m.name, db);
    const view = this.ownerView(app, this.effectiveConfig(m, row.config), db);
    const a = m.submissions;
    return {
      module: m.name,
      forms: () => a.forms(view),
      list: (q) => a.list(view, q),
      csv: (q) => a.csv(view, q),
      remove: (id) => a.remove(view, id),
    };
  }

  /** The app's end-user uploads (the module that declares `files`), or null. */
  async files(app: HookApp): Promise<BoundFiles | null> {
    const m = filesAuthorityOf(this.modules);
    if (!m?.files) return null;
    const db = this.deps.db();
    const row = await readConfigRow(app.id, m.name, db);
    const view = this.ownerView(app, this.effectiveConfig(m, row.config), db);
    const a = m.files;
    return {
      module: m.name,
      list: (q) => a.list(view, q),
      open: (id) => a.open(view, id),
      remove: (id) => a.remove(view, id),
    };
  }

  // ── skills ──

  skillList(): SkillListItem[] {
    return this.skills.map((s) => ({ name: s.name, use_when: s.useWhen }));
  }

  /** One skill's documentation, or null (the caller answers not_found + the list). */
  skillInfo(name: string): SkillInfo | null {
    const s = this.skills.find((x) => x.name === name);
    if (!s) return null;
    const out: SkillInfo = { name: s.name, kind: s.kind, use_when: s.useWhen, content: s.markdown };
    const m = s.module;
    if (!m) return out;
    const types = moduleTypes(m);
    if (types) {
      out.sdk = {
        import: "import { drobek } from 'drobek';",
        types: `${types}\n// drobek.${m.name}: ${m.name}.Api`,
      };
      if (m.sdk?.inline) {
        out.sdk.inline = { import: `import { … } from 'drobek/${m.name}';`, types: m.sdk.inline.types.trim() };
      }
    }
    let schema: unknown = null;
    try {
      schema = z.toJSONSchema(m.configSchema as z.ZodType, { unrepresentable: 'any' });
    } catch {
      schema = null;
    }
    out.config = {
      schema,
      defaults: m.configDefaults,
      confirm_required: m.confirmRequired
        ? 'Some changes need the app owner\'s confirmation in the dashboard: configure_module then answers applied:false with pending_confirmation and a confirm_url for the user.'
        : 'Every valid change applies immediately.',
    };
    if (m.limits?.length) {
      const d = this.deps.limits.defaults();
      out.limits = m.limits.map((l) => ({ name: l.env, value: d[l.env] ?? l.default, meaning: l.meaning }));
    }
    if (m.secrets?.length) {
      out.secrets = m.secrets.map((x) => ({ name: x.name, description: x.description, required: x.required === true }));
    }
    return out;
  }

  /** The hint for a compile message: backend imports point at the skill that replaces them. */
  compileHint(msg: { code?: string; specifier?: string }): string | undefined {
    if (msg.code !== 'unresolved_import' || !msg.specifier) return undefined;
    const skill = skillForImport(msg.specifier);
    if (!skill) return undefined;
    return this.skills.some((s) => s.name === skill) ? skillHint(skill) : skillHint();
  }

  // ── config ──

  /** The config's JSON Schema for forms (the INPUT side: defaulted keys are optional), or null. */
  configJsonSchema(m: AnyModule): unknown {
    try {
      return z.toJSONSchema(m.configSchema as z.ZodType, { unrepresentable: 'any', io: 'input' });
    } catch {
      return null;
    }
  }

  /** The modules of `appId` with a change waiting for the owner (active modules only). */
  async pendingSummary(appId: string): Promise<{ module: string; changes: string[] }[]> {
    const rows = await readConfigRows(appId, this.modules.map((m) => m.name));
    const out: { module: string; changes: string[] }[] = [];
    for (const m of this.modules) {
      const p = rows.get(m.name)?.pending;
      if (p) out.push({ module: m.name, changes: p.changes });
    }
    return out;
  }

  /**
   * One module of one app for the owner's dashboard (M2-02): schema, defaults,
   * stored + effective config, the pending change with its effective result,
   * the declared secrets with hasSecret / updated_at (NEVER a value), the rule
   * operations and the module's secret-free appInfo.
   */
  async moduleView(app: HookApp, name: string): Promise<ModuleDashboardView> {
    const m = this.requireModule(name);
    const row = await readConfigRow(app.id, m.name, this.deps.db());
    const config = this.effectiveConfig(m, row.config);
    let pending: PendingView | null = null;
    if (row.pending) {
      const r = m.configSchema.safeParse(mergePatch(m.configDefaults, mergePatch(row.config, row.pending.patch)));
      pending = {
        changes: row.pending.changes,
        proposed_at: row.pending.proposed_at,
        proposed_by: row.pending.proposed_by,
        confirm_role: row.pending.confirm_role ?? 'editor',
        after: r.success ? r.data : null,
      };
      if (!r.success) pending.invalid = issuePaths(r.error.issues);
    }
    const docs = m.secrets ?? [];
    const status = await secretsStatus(app.id, m.name, docs.map((s) => s.name));
    const view: ModuleDashboardView = {
      name: m.name,
      version: m.version,
      use_when: m.skill.useWhen,
      schema: this.configJsonSchema(m),
      defaults: m.configDefaults,
      stored: row.config,
      config,
      pending,
      secrets: docs.map((s) => ({
        name: s.name,
        description: s.description,
        required: s.required === true,
        hasSecret: status.has(s.name),
        updated_at: status.get(s.name)?.toISOString() ?? null,
      })),
      ops: { ...(m.rules?.ops ?? {}) },
      confirms: Boolean(m.confirmRequired),
    };
    const info = await this.appInfo(m, app, config);
    if (info) view.info = info;
    return view;
  }

  /**
   * The effective config of `module` for a stored (sparse) config. Memoized
   * by content (configMemo); every caller gets its own copy, so a handler that
   * mutates `ctx.config` cannot change what the next request sees.
   */
  effectiveConfig(m: AnyModule, stored: Record<string, unknown>): unknown {
    const key = `${m.name}:${jsonKey(stored)}`;
    const hit = this.configMemo.get(key);
    if (hit) return structuredClone(hit.value);
    const r = m.configSchema.safeParse(mergePatch(m.configDefaults, stored));
    let value: unknown;
    if (r.success) value = r.data;
    else {
      this.deps.log.warn('stored module config no longer passes configSchema — using the defaults', { module: m.name });
      value = m.configDefaults;
    }
    try {
      const copy = structuredClone(value);
      this.configMemo.set(key, { value: copy });
      return structuredClone(copy);
    } catch {
      return value; // not cloneable (a module's transform made a function?): never memoized
    }
  }

  /**
   * The secret-free `appInfo` of module `m` for `app` (undefined when the
   * module has none, or it failed — logged, never fatal).
   */
  private async appInfo(m: AnyModule, app: HookApp, config: unknown): Promise<Record<string, unknown> | undefined> {
    if (!m.appInfo) return undefined;
    try {
      return await m.appInfo({ app, config, db: this.deps.db(), log: this.deps.log });
    } catch (err) {
      this.deps.log.error('module appInfo failed', { module: m.name, app_id: app.id, error: String((err as Error)?.stack ?? err) });
      return undefined;
    }
  }

  /**
   * get_app's `modules`. Pass the app (not only its id) to include each
   * module's `info` (it needs the app's workspace).
   */
  async appModules(app: string | HookApp, confirmLink?: (module: string) => string): Promise<Record<string, AppModuleState>> {
    const appId = typeof app === 'string' ? app : app.id;
    const rows = await readConfigRows(appId, this.modules.map((m) => m.name));
    const out: Record<string, AppModuleState> = {};
    for (const m of this.modules) {
      const row = rows.get(m.name);
      const stored = row?.config ?? {};
      const state: AppModuleState = {
        configured: Object.keys(stored).length > 0,
        config: this.effectiveConfig(m, stored),
        pending: Boolean(row?.pending),
      };
      if (row?.pending) {
        state.pending_confirmation = row.pending.changes;
        if (row.pending.confirm_role === 'admin') state.confirm_role = 'admin';
        if (confirmLink) state.confirm_url = confirmLink(m.name);
      }
      if (m.secrets?.length) {
        const set = await secretsSet(appId, m.name, m.secrets.map((s) => s.name));
        state.secrets = m.secrets.map((s) => ({ name: s.name, hasSecret: set.has(s.name) }));
      }
      if (typeof app !== 'string') {
        const info = await this.appInfo(m, app, state.config);
        if (info) state.info = info;
      }
      out[m.name] = state;
    }
    return out;
  }

  private requireModule(name: string): AnyModule {
    const m = typeof name === 'string' ? this.byName.get(name) : undefined;
    if (!m) {
      throw new ModuleError('not_found', `No platform module "${String(name)}" is active on this server.`, {
        details: { available: this.modules.map((x) => x.name) },
        hint: skillHint(),
      });
    }
    return m;
  }

  private validateConfig(m: AnyModule, candidate: unknown): unknown {
    const r = m.configSchema.safeParse(candidate);
    if (!r.success) {
      throw new ModuleError('invalid_params', `The ${m.name} config is invalid.`, {
        details: { issues: issuePaths(r.error.issues) },
        hint: skillHint(m.name),
      });
    }
    return r.data;
  }

  private async missingSecrets(appId: string, m: AnyModule): Promise<string[]> {
    const required = (m.secrets ?? []).filter((s) => s.required).map((s) => s.name);
    if (required.length === 0) return [];
    const set = await secretsSet(appId, m.name, required);
    return required.filter((n) => !set.has(n));
  }

  /** configure_module: validate a partial config; apply it, or hold it for the owner. */
  async configure(input: ConfigureInput): Promise<ConfigureResult> {
    const m = this.requireModule(input.module);
    const patch = input.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ModuleError('invalid_params', '`config` must be a JSON object (a partial config; null removes a key).', {
        hint: skillHint(m.name),
      });
    }
    if (scanForSecrets('config', JSON.stringify(patch)).length > 0) {
      throw new ModuleError(
        'invalid_params',
        'The config contains something that looks like a credential. Secrets are never set over MCP — the app owner enters them in the drobek dashboard.',
        { hint: skillHint(m.name) }
      );
    }
    const link = confirmUrl(this.deps.env, input.app.workspaceSlug, input.app.slug, m.name);
    const surface = input.surface ?? 'mcp';

    const result = await withLockedConfig(input.app.id, m.name, async (row, write, tx) => {
      const before = this.effectiveConfig(m, row.config);
      const nextStored = mergePatch(row.config, patch) as Record<string, unknown>;
      const after = this.validateConfig(m, mergePatch(m.configDefaults, nextStored));
      const waiting = row.pending?.changes ?? [];

      if (jsonEqual(nextStored, row.config)) {
        return { applied: true, config: before, pending: waiting, role: row.pending?.confirm_role, unchanged: true as const };
      }
      const hookApp: HookApp = { id: input.app.id, slug: input.app.slug, workspaceId: input.app.workspaceId };
      const required = m.confirmRequired ? await m.confirmRequired(before, after, { app: hookApp, db: tx as unknown as DB }) : [];
      const { changes, role } = normalizeConfirmItems(Array.isArray(required) ? required : []);
      if (changes.length === 0) {
        await write({ config: nextStored });
        await writeAudit(
          {
            workspaceId: input.app.workspaceId,
            actorUserId: input.actorUserId,
            actorKind: actorKindForSurface(surface),
            action: 'module.configure',
            subjectType: 'app',
            target: input.app.slug,
            meta: { module: m.name, keys: Object.keys(patch as object) },
          },
          tx
        );
        return { applied: true, config: after, pending: waiting, role: row.pending?.confirm_role };
      }
      const pending: PendingChange = {
        patch: patch as Record<string, unknown>,
        changes,
        proposed_at: new Date().toISOString(),
        proposed_by: input.actorUserId,
        confirm_role: role,
      };
      await write({ pending });
      await writeAudit(
        {
          workspaceId: input.app.workspaceId,
          actorUserId: input.actorUserId,
          actorKind: actorKindForSurface(surface),
          action: 'module.pending',
          subjectType: 'app',
          target: input.app.slug,
          meta: { module: m.name, changes, ...(role === 'admin' ? { confirm_role: role } : {}) },
        },
        tx
      );
      return { applied: false, config: before, pending: changes, role };
    });

    const out: ConfigureResult = {
      module: m.name,
      applied: result.applied,
      config: result.config,
      pending_confirmation: result.pending,
    };
    if (result.pending.length > 0) {
      if (result.role === 'admin') out.confirm_role = 'admin';
      out.confirm_url = link;
    }
    if ('unchanged' in result && result.unchanged) out.unchanged = true;
    const missing = await this.missingSecrets(input.app.id, m);
    if (missing.length > 0) out.secrets_missing = missing;
    const info = await this.appInfo(m, { id: input.app.id, slug: input.app.slug, workspaceId: input.app.workspaceId }, result.config);
    if (info) out.info = info;
    // A change an AGENT proposed now waits: tell the owners (best effort, 1/h per app).
    if (!result.applied && surface === 'mcp') await this.notifyPendingOwners(m, input.app);
    return out;
  }

  /**
   * E-mail the app's owners that changes wait for their confirmation (M2-02):
   * through the module e-mail path (`{ appOwners: true }`, the mail authority
   * — the `email` module — and the operator-wide budgets), at most once per
   * app per hour (PENDING_MAIL_WINDOW_MS), listing every module that waits.
   * Never fails the configure call: without a mail authority nothing is sent
   * (the dashboard banner shows it), and any refusal is logged.
   */
  private async notifyPendingOwners(
    m: AnyModule,
    app: { id: string; slug: string; workspaceId: string; workspaceSlug: string }
  ): Promise<void> {
    const deps = this.deps;
    try {
      if (!mailAuthorityOf(this.modules)?.mail) return;
      const slot = await deps.rateLimit(pendingMailKey(app.id), 1, PENDING_MAIL_WINDOW_MS);
      if (!slot.ok) return;
      const waiting = await this.pendingSummary(app.id);
      if (waiting.length === 0) return;
      const [row] = await deps.db().select({ name: apps.name }).from(apps).where(eq(apps.id, app.id)).limit(1);
      const mail = pendingMail({
        appName: row?.name ?? app.slug,
        modules: waiting.map((w) => ({ ...w, confirmUrl: confirmUrl(deps.env, app.workspaceSlug, app.slug, w.module) })),
      });
      const hookApp: HookApp = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
      const out = await this.sendEmail(m, hookApp, { kind: 'anon' }, {}, () => deps.limits.forWorkspace(app.workspaceId), {
        to: { appOwners: true },
        subject: mail.subject,
        text: mail.text,
      });
      deps.log.info('pending-change e-mail sent', { app_id: app.id, module: m.name, recipients: out.sent });
    } catch (err) {
      deps.log.warn('pending-change e-mail not sent', {
        app_id: app.id,
        module: m.name,
        error: isModuleError(err) ? err.code : redactAddresses(String((err as Error)?.message ?? err)),
      });
    }
  }

  /** The owner confirms the pending change (dashboard): apply it on top of the current config. */
  async confirm(input: DecisionInput): Promise<{ module: string; config: unknown; confirmed: string[] }> {
    const m = this.requireModule(input.module);
    return withLockedConfig(input.app.id, m.name, async (row, write, tx) => {
      if (!row.pending) throw new ModuleError('conflict', `Nothing is waiting for confirmation in ${m.name}.`, { details: { reason: 'nothing_pending' } });
      const role: ConfirmRole = input.role === 'admin' ? 'admin' : 'editor';
      if (row.pending.confirm_role === 'admin' && role !== 'admin') {
        throw new ModuleError('forbidden', `Only a workspace admin can confirm this ${m.name} change (an editor may reject it).`, {
          details: { reason: 'admin_required', confirm_role: 'admin' },
        });
      }
      const nextStored = mergePatch(row.config, row.pending.patch) as Record<string, unknown>;
      const r = m.configSchema.safeParse(mergePatch(m.configDefaults, nextStored));
      if (!r.success) {
        throw new ModuleError('conflict', 'The pending change no longer fits the current config — reject it and ask the agent again.', {
          details: { reason: 'pending_invalid', issues: issuePaths(r.error.issues) },
        });
      }
      await write({ config: nextStored, pending: null });
      if (m.onConfirmed) {
        await m.onConfirmed(this.effectiveConfig(m, row.config), r.data, {
          app: { id: input.app.id, slug: input.app.slug, workspaceId: input.app.workspaceId },
          db: tx as unknown as DB,
          userId: input.userId,
          role,
        });
      }
      await writeAudit(
        {
          workspaceId: input.app.workspaceId,
          actorUserId: input.userId,
          actorKind: actorKindForSurface('web'),
          action: 'module.confirm',
          subjectType: 'app',
          target: input.app.slug,
          meta: { module: m.name, changes: row.pending.changes },
        },
        tx
      );
      return { module: m.name, config: r.data, confirmed: row.pending.changes };
    });
  }

  /** The owner rejects the pending change (dashboard): drop it, config unchanged. */
  async reject(input: DecisionInput): Promise<{ module: string; config: unknown; rejected: string[] }> {
    const m = this.requireModule(input.module);
    return withLockedConfig(input.app.id, m.name, async (row, write, tx) => {
      if (!row.pending) throw new ModuleError('conflict', `Nothing is waiting for confirmation in ${m.name}.`, { details: { reason: 'nothing_pending' } });
      await write({ pending: null });
      await writeAudit(
        {
          workspaceId: input.app.workspaceId,
          actorUserId: input.userId,
          actorKind: actorKindForSurface('web'),
          action: 'module.reject',
          subjectType: 'app',
          target: input.app.slug,
          meta: { module: m.name, changes: row.pending.changes },
        },
        tx
      );
      return { module: m.name, config: this.effectiveConfig(m, row.config), rejected: row.pending.changes };
    });
  }

  // ── hooks ──

  async runHook(hook: 'onAppCreate', app: HookApp): Promise<void>;
  async runHook(hook: 'onPublish', app: HookApp & { version: number }): Promise<void>;
  async runHook(hook: 'onAppCreate' | 'onPublish', app: HookApp & { version?: number }): Promise<void> {
    for (const m of this.modules) {
      const fn = m.hooks?.[hook] as ((a: typeof app, s: { db: DB; log: Logger }) => unknown) | undefined;
      if (!fn) continue;
      try {
        await fn(app, { db: this.deps.db(), log: this.deps.log });
      } catch (err) {
        this.deps.log.error('module hook failed', { module: m.name, hook, app_id: app.id, error: String((err as Error)?.stack ?? err) });
      }
    }
  }

  // ── e-mail ──

  /**
   * `ctx.email.send` of module `m` for `app`: resolve the allowed recipients,
   * refuse while module e-mail is paused, let the mail authority (the `email`
   * module) apply the app's policy and envelope, count against the
   * operator-wide hourly budget of the message's class (sign-in codes vs
   * notifications, plus the app's share of notifications — mail-guard.ts),
   * send one message per address, audit.
   */
  private async sendEmail(
    m: AnyModule,
    app: HookApp,
    principal: Principal,
    config: unknown,
    getLimits: () => Promise<Limits>,
    message: EmailMessage
  ): Promise<{ sent: number }> {
    const deps = this.deps;
    const db = deps.db();
    const kind = emailKind(message.to);
    const to = await resolveRecipients(message.to, { principal, config, owners: () => appOwnerEmails(db, app.workspaceId) });
    if (to.length === 0) return { sent: 0 };
    const subject = sanitizeSubject(message.subject);
    const text = capEmailText(message.text);
    const meta = { app_id: app.id, module: m.name, kind };

    await deps.mailGuard.assertOpen(meta);
    let envelope: MailEnvelope = {};
    const authority = mailAuthorityOf(this.modules);
    if (authority?.mail) {
      const row = await readConfigRow(app.id, authority.name, db);
      envelope = await authority.mail.prepare({
        app,
        module: m.name,
        kind,
        recipients: to.length,
        config: this.effectiveConfig(authority, row.config),
        limits: await getLimits(),
        rateLimit: (bucket, key, max, windowMs) =>
          deps.rateLimit(`mod:${authority.name}:${app.id}:${bucket}:${key}`, max, windowMs),
        log: deps.log,
      });
    } else if (kind !== 'sign_in') {
      throw new ModuleError('unavailable', 'This server sends no app e-mail: the platform module "email" is not active.', {
        hint: skillHint(),
      });
    }
    await deps.mailGuard.admit(to.length, meta);

    let sent = 0;
    try {
      for (const address of to) {
        try {
          await deps.email.send({ to: address, subject, text, ...envelope });
        } catch (err) {
          // SMTP errors can quote the recipient: log them without addresses, answer 503.
          deps.log.error('module e-mail failed', { ...meta, sent, error: redactAddresses(String((err as Error)?.message ?? err)) });
          throw new ModuleError('unavailable', 'The e-mail could not be sent. Try again later.');
        }
        sent += 1;
      }
    } finally {
      if (sent > 0) {
        await writeAudit({
          workspaceId: app.workspaceId,
          actorUserId: null,
          actorKind: actorKindForSurface('apps'),
          action: 'email.send',
          subjectType: 'app',
          target: app.slug,
          meta: { module: m.name, kind, recipients: sent, end_user: principal.kind === 'user' ? principal.id : 'anon' },
        }).catch((err: unknown) => deps.log.error('audit email.send failed', { app_id: app.id, error: String(err) }));
      }
    }
    return { sent };
  }

  // ── HTTP on the app hosts ──

  /** Answer one `/__drobek/*` request of `app` (never throws). */
  async handle(req: PlatformRequest, app: PlatformApp): Promise<PipelineResult> {
    const seen: { module?: string } = {};
    const res = await this.dispatch(req, app, seen);
    if (seen.module) this.countRequest(app.id, seen.module, res.status);
    return res;
  }

  /** get_logs `requests`: one response of an active module (fire-and-forget). */
  private countRequest(appId: string, module: string, status: number): void {
    const count = this.deps.requestStats;
    if (!count) return;
    try {
      void Promise.resolve(count(appId, module, status)).catch(() => undefined);
    } catch {
      /* stats never affect the response */
    }
  }

  private async dispatch(req: PlatformRequest, app: PlatformApp, seen: { module?: string }): Promise<PipelineResult> {
    try {
      if (req.path === SDK_PATH || req.path === SDK_TYPES_PATH) return this.serveSdk(req);
      if (req.path === BEACON_SCRIPT_PATH) return this.serveBeaconScript(req);
      const match = V1_RE.exec(req.path);
      if (!match) {
        return errorResult(new ModuleError('not_found', 'No such drobek endpoint.', { hint: skillHint() }));
      }
      const m = this.byName.get(match[1]);
      if (!m) {
        return errorResult(
          new ModuleError('not_found', `No platform module "${match[1]}" is active on this server.`, {
            details: { available: this.modules.map((x) => x.name) },
            hint: skillHint(),
          })
        );
      }
      seen.module = m.name;
      const hit = matchRoute(this.routes.get(m.name) ?? [], req.method, match[2] ?? '/');
      if (hit.kind === 'not_found') {
        return errorResult(new ModuleError('not_found', `${m.name} has no route ${req.method} ${match[2] ?? '/'}.`), m.name);
      }
      if (hit.kind === 'method_not_allowed') {
        return errorResult(
          new ModuleError('method_not_allowed', `Use ${hit.allow.join(' or ')} here.`, { headers: { Allow: hit.allow.join(', ') } }),
          m.name
        );
      }
      const host = req.header('host');
      const selfOrigin = host ? `${appsOrigin(this.deps.env).scheme}://${host.trim().toLowerCase()}` : null;
      let limits: Limits | null = null;
      const getLimits = async () => (limits ??= await this.deps.limits.forWorkspace(app.workspaceId));
      const res = await runRoute({ ...req, path: match[2] ?? '/' }, hit.route, hit.params, {
        module: m.name,
        selfOrigin,
        principal: () =>
          this.deps.principal({
            app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId },
            cookieHeader: req.header('cookie'),
          }),
        context: (principal) => this.context(m, app, principal, getLimits),
        limit: async (name) => {
          const l = await getLimits();
          const v = l[name];
          if (typeof v !== 'number') throw new Error(`module "${m.name}" rate-limits on unknown limit "${name}"`);
          return v;
        },
      });
      if (req.method.toUpperCase() === 'HEAD') {
        if (isReadable(res.body)) res.body.destroy();
        return { ...res, body: null };
      }
      return res;
    } catch (err) {
      if (isModuleError(err)) return errorResult(err);
      this.deps.log.error('module request failed', { app_id: app.id, path: req.path, error: String((err as Error)?.stack ?? err) });
      return errorResult(new ModuleError('internal_error', 'drobek hit an internal error.'));
    }
  }

  private serveSdk(req: PlatformRequest): PipelineResult {
    const js = req.path === SDK_PATH;
    return this.serveScript(req, {
      body: js ? this.sdk.js : Buffer.from(this.sdk.dts, 'utf8'),
      etag: `"${this.sdk.hash}${js ? '' : '-d'}"`,
      hash: this.sdk.hash,
      contentType: js ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
    });
  }

  private serveBeaconScript(req: PlatformRequest): PipelineResult {
    const b = this.sdk.beacon;
    return this.serveScript(req, { body: b.js, etag: `"${b.hash}-b"`, hash: b.hash, contentType: 'text/javascript; charset=utf-8' });
  }

  /** A platform script: `?v=<hash>` → immutable, otherwise revalidated by ETag. */
  private serveScript(req: PlatformRequest, s: { body: Buffer; etag: string; hash: string; contentType: string }): PipelineResult {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return errorResult(new ModuleError('method_not_allowed', 'Use GET here.', { headers: { Allow: 'GET, HEAD' } }));
    }
    const v = new URLSearchParams(req.query).get('v');
    const headers: Record<string, string> = {
      'Content-Type': s.contentType,
      ETag: s.etag,
      'Cache-Control': v === s.hash ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
    };
    const inm = req.header('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === s.etag || t.trim() === `W/${s.etag}`)) {
      return { status: 304, headers, body: null };
    }
    headers['Content-Length'] = String(s.body.length);
    return { status: 200, headers, body: method === 'HEAD' ? null : s.body };
  }

  private async context(
    m: AnyModule,
    app: PlatformApp,
    principal: Principal,
    getLimits: () => Promise<Limits>
  ): Promise<ModuleContext<unknown>> {
    const deps = this.deps;
    const row = await readConfigRow(app.id, m.name, deps.db());
    const config = this.effectiveConfig(m, row.config);
    const declared = new Set((m.secrets ?? []).map((s) => s.name));
    const hookApp: HookApp = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };
    return {
      app: hookApp,
      module: m.name,
      principal,
      config,
      db: deps.db(),
      log: deps.log,
      rules: { decide: (rule, ownerId) => decideAccess(rule, principal, ownerId) },
      limits: getLimits,
      rateLimit: (bucket, key, max, windowMs) => deps.rateLimit(`mod:${m.name}:${app.id}:${bucket}:${key}`, max, windowMs),
      secrets: {
        get: async (name) => {
          if (!declared.has(name)) throw new Error(`module "${m.name}" reads undeclared secret "${name}"`);
          return getModuleSecret(app.id, m.name, name, deps.env);
        },
      },
      audit: async (action, meta = {}) => {
        await writeAudit({
          workspaceId: app.workspaceId,
          actorUserId: null,
          actorKind: actorKindForSurface('apps'),
          action: action.startsWith(`${m.name}.`) ? action : `${m.name}.${action}`,
          subjectType: 'app',
          target: app.slug,
          meta: { ...meta, module: m.name, end_user: principal.kind === 'user' ? principal.id : 'anon' },
        });
      },
      email: {
        send: (message) => this.sendEmail(m, hookApp, principal, config, getLimits, message),
        signInShare: deps.mailGuard.budgets?.perAppSignIn,
      },
    };
  }
}

// ── loading ──────────────────────────────────────────────────────────────────

export interface LoadRuntimeOptions extends ResolveOptions {
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** Use these modules instead of resolving DROBEK_MODULES (tests). */
  modules?: AnyModule[];
  /** Directory of the general skills (default: generalSkillsDir()). null = none. */
  skillsDir?: string | null;
  /** Apply a module's migrations (default: runJournalMigrations against DATABASE_URL). */
  migrate?: (folder: string, table: string) => Promise<void>;
  deps?: Partial<RuntimeDeps>;
}

export function moduleJournalTable(name: string): string {
  return `__drizzle_migrations_mod_${name}`;
}

/** Load the active modules, apply their migrations, compose the SDK, collect the skills. */
export async function loadModuleRuntime(opts: LoadRuntimeOptions = {}): Promise<ModuleRuntime> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? opts.deps?.log ?? createConsoleLogger('modules');
  const modules = opts.modules ?? (await loadModules(env, opts));
  const authority = endUserAuthorityOf(modules);
  mailAuthorityOf(modules);
  recordsAuthorityOf(modules);
  submissionsAuthorityOf(modules);
  filesAuthorityOf(modules);
  checkRequires(modules);

  if (env.DROBEK_MIGRATE_ON_START !== '0') {
    const migrate =
      opts.migrate ??
      ((folder: string, table: string) => runJournalMigrations({ migrationsFolder: folder, migrationsTable: table }));
    for (const m of modules) {
      if (!m.migrations) continue;
      log.info('applying module migrations', { module: m.name });
      await migrate(toPath(m.migrations.folder), moduleJournalTable(m.name));
    }
  }

  const sdk = await buildSdk(modules);
  const skillsDir = opts.skillsDir === undefined ? generalSkillsDir(env) : opts.skillsDir;
  const skills = mergeSkills(moduleSkills(modules), loadGeneralSkills(skillsDir, log), log);
  // Bound below: the resolver asks the runtime (the session owner's
  // `endUsers.current` with the app's config) about every live session.
  let runtime: ModuleRuntime | null = null;
  const deps: RuntimeDeps = {
    env,
    log,
    db: getDb,
    limits: createLimitsProvider({ catalogue: modules.flatMap((m) => m.limits ?? []), env, redis: getRedis, log }),
    principal: cookiePrincipalResolver({
      redis: getRedis,
      secure: endUserCookiesSecure(env),
      current: authority ? (app, user) => (runtime ? runtime.currentEndUser(app, user) : Promise.resolve(null)) : null,
    }),
    rateLimit: redisRateLimiter(getRedis),
    email: smtpEmailTransport(log, env),
    mailGuard: redisMailGuard({
      redis: () => getRedis() as unknown as MailGuardRedis,
      config: mailGuardConfigFromEnv(env),
      log,
    }),
    requestStats: (appId, module, status) => recordModuleRequest(appId, module, status),
    ...opts.deps,
  };
  runtime = new ModuleRuntime({ modules, skills, sdk, deps });
  log.info('platform modules ready', {
    modules: modules.map((m) => `${m.name}@${m.version}`),
    skills: skills.map((s) => s.name),
    sdk: sdk.url,
  });
  return runtime;
}

const GLOBAL_KEY = Symbol.for('drobek.modules.runtime');
type Holder = { [GLOBAL_KEY]?: Promise<ModuleRuntime> };

/**
 * The process-wide runtime: loaded once from the environment on first use
 * (the server entry awaits it at boot, so a bad DROBEK_MODULES stops the
 * start). Shared through globalThis with the dev server's Vite-loaded copy.
 */
export function moduleRuntime(opts?: LoadRuntimeOptions): Promise<ModuleRuntime> {
  const g = globalThis as Holder;
  if (!g[GLOBAL_KEY]) {
    const p = loadModuleRuntime(opts);
    g[GLOBAL_KEY] = p;
    p.catch(() => {
      if (g[GLOBAL_KEY] === p) delete g[GLOBAL_KEY];
    });
  }
  return g[GLOBAL_KEY];
}

/** Tests: install a runtime (or null to reset). */
export function setModuleRuntimeForTests(runtime: ModuleRuntime | null): void {
  const g = globalThis as Holder;
  if (runtime) g[GLOBAL_KEY] = Promise.resolve(runtime);
  else delete g[GLOBAL_KEY];
}
