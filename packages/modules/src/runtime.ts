/**
 * The module runtime of ONE server process (M1-01): the active modules, their
 * route tables, the composed SDK and the skill registry — plus the operations
 * the rest of drobek calls:
 *
 *  - `handle()` — every `/__drobek/*` request on an app host (after the app
 *    and its visibility gate were resolved by @drobek/serving);
 *  - `skillList()` / `skillInfo()` — the `skill_info` tool, create_app, get_app;
 *  - `configure()` / `confirm()` / `reject()` — configure_module and the
 *    dashboard's pending-change API;
 *  - `appModules()` — get_app's `modules` (configured, pending, hasSecret);
 *  - `compileHint()` — the skill an `unresolved_import` should point at;
 *  - `runHook()` — onAppCreate / onPublish.
 *
 * `moduleRuntime()` is the process-wide instance, loaded once from
 * `DROBEK_MODULES` (memoised on globalThis, so the dev server's Vite-loaded
 * route modules share the instance the server entry created).
 */
import { appsOrigin, dashboardOrigin } from '@drobek/apps';
import { actorKindForSurface, writeAudit } from '@drobek/audit';
import { escapeHtml, getEmailFrom, getSmtpTransport, renderEmailLayout, smtpConfigured } from '@drobek/auth';
import { scanForSecrets } from '@drobek/compile';
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import { getDb, runJournalMigrations, type DB } from '@drobek/db';
import { z } from 'zod';
import type { AnyModule, EndUser, HookApp, Limits, ModuleContext, Principal, RateLimitResult } from './contract.js';
import { readConfigRow, readConfigRows, withLockedConfig, type PendingChange } from './configs.server.js';
import { resolveRecipients, sanitizeSubject } from './email.js';
import { ModuleError, isModuleError, issuePaths, skillHint } from './errors.js';
import { createLimitsProvider, type LimitsProvider } from './limits.js';
import { jsonEqual, mergePatch } from './merge-patch.js';
import { cookiePrincipalResolver, endUserCookiesSecure, type PrincipalResolver } from './principal.js';
import { ModuleLoadError, endUserAuthorityOf, loadModules, type ResolveOptions } from './registry.js';
import { collectRoutes, errorResult, matchRoute, runRoute, type PipelineRequest, type PipelineResult, type Route } from './router.js';
import { decideAccess } from './rules.js';
import { SDK_PATH, SDK_TYPES_PATH, buildSdk, moduleTypes, toPath, type SdkBundle } from './sdk-build.js';
import { getModuleSecret, secretsSet } from './secrets.server.js';
import { generalSkillsDir, loadGeneralSkills, mergeSkills, moduleSkills, skillForImport, type SkillEntry } from './skills.js';

// ── deps ─────────────────────────────────────────────────────────────────────

export type RateLimiter = (key: string, max: number, windowMs: number) => Promise<RateLimitResult>;

export interface EmailTransport {
  send(message: { to: string[]; subject: string; text: string }): Promise<void>;
}

export interface RuntimeDeps {
  env: NodeJS.ProcessEnv;
  log: Logger;
  db: () => DB;
  limits: LimitsProvider;
  principal: PrincipalResolver;
  rateLimit: RateLimiter;
  email: EmailTransport;
}

type RedisLike = ReturnType<typeof getRedis>;

/** Fixed-window counter in Redis (atomic INCR + PEXPIRE), `drobek:rl:` keys. */
export function redisRateLimiter(redis: () => Pick<RedisLike, 'incr' | 'pexpire' | 'ttl'>): RateLimiter {
  return async (key, max, windowMs) => {
    const r = redis();
    const k = `drobek:rl:${key}`;
    const n = await r.incr(k);
    if (n === 1) await r.pexpire(k, windowMs);
    if (n <= max) return { ok: true, retryAfterSec: 0 };
    const ttl = await r.ttl(k);
    if (ttl < 0) await r.pexpire(k, windowMs); // a key that lost its expiry must not lock forever
    return { ok: false, retryAfterSec: Math.max(1, ttl > 0 ? ttl : Math.ceil(windowMs / 1000)) };
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
    return w.n <= max ? { ok: true, retryAfterSec: 0 } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
  }) as RateLimiter & { reset(): void };
  fn.reset = () => windows.clear();
  return fn;
}

/** Plain-text mail through the operator's SMTP (the same transport as login codes). */
export function smtpEmailTransport(log: Logger): EmailTransport {
  return {
    async send({ to, subject, text }) {
      if (!smtpConfigured()) {
        if (process.env.NODE_ENV === 'production') throw new Error('SMTP is not configured');
        log.info('module e-mail not sent (SMTP not configured in dev)', { recipients: to.length, subject });
        return;
      }
      const t = await getSmtpTransport();
      const html = renderEmailLayout({
        preview: subject,
        body: `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</p>`,
      });
      await t.sendMail({ from: getEmailFrom(), to, subject, text, html });
    },
  };
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
  confirm_url?: string;
  secrets?: { name: string; hasSecret: boolean }[];
}

export interface ConfigureInput {
  app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
  module: string;
  patch: unknown;
  /** The dashboard user whose agent calls (audit + pending.proposed_by). */
  actorUserId: string;
}

export interface ConfigureResult {
  module: string;
  applied: boolean;
  /** The effective config now in force. */
  config: unknown;
  /** Changes waiting for the owner ([] when nothing waits). */
  pending_confirmation: string[];
  confirm_url?: string;
  secrets_missing?: string[];
  unchanged?: true;
}

export interface DecisionInput {
  app: { id: string; slug: string; workspaceId: string };
  module: string;
  userId: string;
}

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'public, max-age=0, must-revalidate';
const V1_RE = /^\/__drobek\/v1\/([^/]+)(\/.*)?$/;

/** The dashboard page where the owner confirms a module change (M2-02 serves it). */
export function confirmUrl(env: NodeJS.ProcessEnv, workspaceSlug: string, appSlug: string, module: string): string {
  return `${dashboardOrigin(env)}/workspaces/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}/modules/${encodeURIComponent(module)}`;
}

// ── the runtime ──────────────────────────────────────────────────────────────

export class ModuleRuntime {
  readonly modules: AnyModule[];
  readonly skills: SkillEntry[];
  readonly sdk: SdkBundle;
  readonly deps: RuntimeDeps;
  private readonly routes = new Map<string, Route[]>();
  private readonly byName = new Map<string, AnyModule>();

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

  /** The effective config of `module` for a stored (sparse) config. */
  effectiveConfig(m: AnyModule, stored: Record<string, unknown>): unknown {
    const r = m.configSchema.safeParse(mergePatch(m.configDefaults, stored));
    if (r.success) return r.data;
    this.deps.log.warn('stored module config no longer passes configSchema — using the defaults', { module: m.name });
    return m.configDefaults;
  }

  async appModules(appId: string, confirmLink?: (module: string) => string): Promise<Record<string, AppModuleState>> {
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
        if (confirmLink) state.confirm_url = confirmLink(m.name);
      }
      if (m.secrets?.length) {
        const set = await secretsSet(appId, m.name, m.secrets.map((s) => s.name));
        state.secrets = m.secrets.map((s) => ({ name: s.name, hasSecret: set.has(s.name) }));
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

    const result = await withLockedConfig(input.app.id, m.name, async (row, write, tx) => {
      const before = this.effectiveConfig(m, row.config);
      const nextStored = mergePatch(row.config, patch) as Record<string, unknown>;
      const after = this.validateConfig(m, mergePatch(m.configDefaults, nextStored));
      const waiting = row.pending?.changes ?? [];

      if (jsonEqual(nextStored, row.config)) {
        return { applied: true, config: before, pending: waiting, unchanged: true as const };
      }
      const changes = (m.confirmRequired?.(before, after) ?? []).filter((c) => typeof c === 'string' && c.length > 0);
      if (changes.length === 0) {
        await write({ config: nextStored });
        await writeAudit(
          {
            workspaceId: input.app.workspaceId,
            actorUserId: input.actorUserId,
            actorKind: actorKindForSurface('mcp'),
            action: 'module.configure',
            subjectType: 'app',
            target: input.app.slug,
            meta: { module: m.name, keys: Object.keys(patch as object) },
          },
          tx
        );
        return { applied: true, config: after, pending: waiting };
      }
      const pending: PendingChange = {
        patch: patch as Record<string, unknown>,
        changes,
        proposed_at: new Date().toISOString(),
        proposed_by: input.actorUserId,
      };
      await write({ pending });
      await writeAudit(
        {
          workspaceId: input.app.workspaceId,
          actorUserId: input.actorUserId,
          actorKind: actorKindForSurface('mcp'),
          action: 'module.pending',
          subjectType: 'app',
          target: input.app.slug,
          meta: { module: m.name, changes },
        },
        tx
      );
      return { applied: false, config: before, pending: changes };
    });

    const out: ConfigureResult = {
      module: m.name,
      applied: result.applied,
      config: result.config,
      pending_confirmation: result.pending,
    };
    if (result.pending.length > 0) out.confirm_url = link;
    if ('unchanged' in result && result.unchanged) out.unchanged = true;
    const missing = await this.missingSecrets(input.app.id, m);
    if (missing.length > 0) out.secrets_missing = missing;
    return out;
  }

  /** The owner confirms the pending change (dashboard): apply it on top of the current config. */
  async confirm(input: DecisionInput): Promise<{ module: string; config: unknown; confirmed: string[] }> {
    const m = this.requireModule(input.module);
    return withLockedConfig(input.app.id, m.name, async (row, write, tx) => {
      if (!row.pending) throw new ModuleError('conflict', `Nothing is waiting for confirmation in ${m.name}.`, { details: { reason: 'nothing_pending' } });
      const nextStored = mergePatch(row.config, row.pending.patch) as Record<string, unknown>;
      const r = m.configSchema.safeParse(mergePatch(m.configDefaults, nextStored));
      if (!r.success) {
        throw new ModuleError('conflict', 'The pending change no longer fits the current config — reject it and ask the agent again.', {
          details: { reason: 'pending_invalid', issues: issuePaths(r.error.issues) },
        });
      }
      await write({ config: nextStored, pending: null });
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

  // ── HTTP on the app hosts ──

  /** Answer one `/__drobek/*` request of `app` (never throws). */
  async handle(req: PlatformRequest, app: PlatformApp): Promise<PipelineResult> {
    try {
      if (req.path === SDK_PATH || req.path === SDK_TYPES_PATH) return this.serveSdk(req);
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
      if (req.method.toUpperCase() === 'HEAD') return { ...res, body: null };
      return res;
    } catch (err) {
      if (isModuleError(err)) return errorResult(err);
      this.deps.log.error('module request failed', { app_id: app.id, path: req.path, error: String((err as Error)?.stack ?? err) });
      return errorResult(new ModuleError('internal_error', 'drobek hit an internal error.'));
    }
  }

  private serveSdk(req: PlatformRequest): PipelineResult {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return errorResult(new ModuleError('method_not_allowed', 'Use GET here.', { headers: { Allow: 'GET, HEAD' } }));
    }
    const js = req.path === SDK_PATH;
    const etag = `"${this.sdk.hash}${js ? '' : '-d'}"`;
    const v = new URLSearchParams(req.query).get('v');
    const headers: Record<string, string> = {
      'Content-Type': js ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8',
      ETag: etag,
      'Cache-Control': v === this.sdk.hash ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
    };
    const inm = req.header('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
      return { status: 304, headers, body: null };
    }
    const body = js ? this.sdk.js : Buffer.from(this.sdk.dts, 'utf8');
    headers['Content-Length'] = String(body.length);
    return { status: 200, headers, body: method === 'HEAD' ? null : body };
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
        send: async (message) => {
          const to = resolveRecipients(message.to, principal, config);
          if (to.length === 0) return { sent: 0 };
          await deps.email.send({ to, subject: sanitizeSubject(message.subject), text: String(message.text) });
          return { sent: to.length };
        },
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
    email: smtpEmailTransport(log),
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
