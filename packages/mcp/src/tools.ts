/**
 * The MCP tool bodies: list_apps, create_app, get_app,
 * write_files, restore_version, publish, skill_info, configure_module,
 * query_data, get_logs, set_gallery_listing, duplicate_app and sync_now.
 * Each takes the caller + validated arguments and returns a plain JSON payload or throws a ToolError; the MCP
 * wiring (register.ts) turns that into a CallToolResult.
 *
 * Invariants:
 *  - every call authorizes against the TARGET app's workspace (access.ts);
 *  - the server only compiles app code (esbuild), never executes it;
 *  - a credential in a file is refused before anything is stored;
 *  - writes hold the app's single-writer lease (lease.ts); publish does not —
 *    it writes no files, only moves the production pointer. configure_module
 *    takes it too: a module config is part of what the app's agent edits;
 *  - secrets never pass through MCP: skill_info names a module's secrets,
 *    get_app says whether each is set (`hasSecret`), configure_module refuses
 *    credential-looking values. Only the dashboard sets them;
 *  - app data (query_data) is end-user input: returned marked `untrusted`
 *    inside a nonce envelope, from the ONE app the call authorized. So are
 *    logs (get_logs): browser error texts come from the app and its users;
 *  - every compile a write runs lands in the app's compile history
 *    (get_logs 'compile'), refused ones included;
 *  - an app a super-admin took down refuses write_files,
 *    restore_version, publish and configure_module with `app_locked_by_admin`
 *    (the reason category only); list_apps / get_app show `locked_by_admin`;
 *  - listing an app in the public gallery needs the publish scope,
 *    a published app and `user_confirmed: true` — the user's explicit yes;
 *    unlisting needs none of that. get_app shows the gallery state;
 *  - duplicate_app copies only a gallery app whose owner allows it, as the
 *    same @drobek/apps + @drobek/modules functions as the dashboard page:
 *    the published files and the module settings through the copy's own
 *    confirmation flow, never secrets, data or the source's proxy upstreams;
 *  - an opt-in module that is off for the app's workspace is left
 *    out of the app's skills and compile hints, get_app says
 *    `enabled: false` and configure_module answers `module_not_enabled`;
 *  - publish in a workspace a super-admin blocked answers `publish_blocked`,
 *    and with PUBLISH_APPROVAL=approval in one the operator has not allowed
 *    `publish_not_approved` (both + `contact`); list_apps and
 *    get_app say `can_publish` (+ `publish_contact`) and the workspace's
 *    `publishing` state.
 */
import {
  APP_LOCK_TTL_SEC,
  REASONING_MAX_CHARS,
  WRITE_FILES_EDITS_MAX,
  WRITE_FILES_MAX,
  listAppsNext,
  renderBriefing,
} from '@drobek/agent-dx';
import {
  AppsError,
  classifyHost,
  copyName,
  createApp as createAppRow,
  createVersion,
  dashboardOrigin,
  deriveSlug,
  duplicateAppFiles,
  duplicationSource,
  galleryCounts,
  galleryEnabled,
  galleryState,
  getVersion,
  hostConfig,
  lockCategory,
  listAssets,
  listVersions,
  normalizeGalleryDescription,
  previewUrl,
  publishPermissions,
  publish as publishVersion,
  publishedUrl,
  readBlobs,
  readVersionFile,
  restore,
  scheduleVersionTypecheck,
  setGalleryListing,
  suggestSlug,
  validateAppSlug,
  type Actor,
  type VersionFileInput,
  type WorkspacePublishing,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { listDomains, resolveCustomHost, verifiedDomainsOf } from '@drobek/domains';
import { maskEmail } from '@drobek/auth';
import {
  CONFIG_FILE,
  TEXT_EXTS,
  normalizeAppPath,
  readAppConfig,
  scanForSecrets,
  type CompileMessage,
  type CompileResult,
} from '@drobek/compile';
import { confirmUrl, duplicateModuleConfigs, isModuleError, type ModuleRuntime, type SkillListItem } from '@drobek/modules';
import { ensurePersonalWorkspace, listAllWorkspaces, listUserWorkspaces } from '@drobek/tenancy';
import { authorizeApp, authorizeWorkspace } from './access.js';
import type { ToolDeps, ToolPrincipal } from './context.js';
import { LOG_KINDS, logsWindowStart, type LogKind, type RuntimeEntry } from '@drobek/insights';
import { dbErrorForLog } from '@drobek/db';
import { ToolError, lockedByAdmin, notFound, publishRefused } from './errors.js';
import type { Lease } from './lease.js';
import { filesReadiness, storedReadiness } from './readiness.js';
import {
  appsInWorkspace,
  appsOfMember,
  emailsByUserIds,
  lastOkVersionNumber,
  latestVersions,
  versionNumbers,
  type AppRow,
} from './queries.js';
import { templateFiles, type TemplateName } from './templates.js';
import { mcpMaxBodyBytes } from './request-limit.js';

export interface CallContext {
  principal: ToolPrincipal;
  /** MCP session id — recorded in the lease (the same user may take it over). */
  sessionId: string;
  deps: ToolDeps;
  /** The platform modules + skills of this process (resolved once per call). */
  modules: ModuleRuntime;
}

const NAME_MAX = 80;

function actorOf(ctx: CallContext): Actor {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') };
}

/** A taken-down app refuses every change (write, restore, publish, module config). */
function refuseIfLockedByAdmin(app: AppRow): void {
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i <= path.lastIndexOf('/') ? '' : path.slice(i).toLowerCase();
}

/**
 * `{ code, file, line, column, text, hint? }` — the agent-facing compile
 * message. `hint` points a backend import the platform replaces at its
 * skill, e.g. `unresolved_import` of `firebase` → `skill_info('data')`.
 */
export interface CompileErrorOut {
  code: string;
  file: string | null;
  line: number | null;
  column: number | null;
  text: string;
  hint?: string;
}

function toCompileOut(messages: unknown, modules?: ModuleRuntime, enabled?: ReadonlySet<string>): CompileErrorOut[] {
  if (!Array.isArray(messages)) return [];
  return (messages as Partial<CompileMessage>[]).map((m) => {
    const out: CompileErrorOut = {
      code: String(m.code ?? 'build_error'),
      file: m.file ?? null,
      line: m.line ?? null,
      column: m.column ?? null,
      text: String(m.text ?? ''),
    };
    const hint = modules?.compileHint({ code: out.code, specifier: m.specifier }, enabled);
    if (hint) out.hint = hint;
    return out;
  });
}

/** The briefing of an app: `enabled` = its workspace's enabledModules(). */
function briefing(ctx: CallContext, enabled: ReadonlySet<string>): string {
  const L = ctx.deps.limits;
  return renderBriefing({
    limits: {
      maxFiles: L.maxFiles,
      maxFileBytes: L.maxFileBytes,
      maxTotalBytes: L.maxTotalBytes,
      timeoutMs: L.timeoutMs,
      maxRequestBytes: mcpMaxBodyBytes(ctx.deps.env, L.maxTotalBytes),
    },
    skills: ctx.modules.skillList(enabled),
  });
}

/** The skills of an app: the opt-in modules off for its workspace are left out. */
function skills(ctx: CallContext, enabled: ReadonlySet<string>): SkillListItem[] {
  return ctx.modules.skillList(enabled);
}

// ── leases ───────────────────────────────────────────────────────────────────

async function takeLease(ctx: CallContext, appId: string): Promise<void> {
  const res = await ctx.deps.leases.acquire(
    appId,
    { userId: ctx.principal.userId, sessionId: ctx.sessionId },
    APP_LOCK_TTL_SEC * 1000
  );
  if (res.acquired) return;
  const emails = await emailsByUserIds([res.lease.holder_user_id]);
  const holder = maskEmail(emails.get(res.lease.holder_user_id) ?? '');
  throw new ToolError(
    'app_locked',
    `${holder} is editing this app right now (their agent holds the write lease until ${res.lease.expires_at}).`,
    { holder, expires_at: res.lease.expires_at }
  );
}

async function lockInfo(
  leases: Map<string, Lease>
): Promise<Map<string, { holder: string; expires_at: string }>> {
  const emails = await emailsByUserIds([...leases.values()].map((l) => l.holder_user_id));
  const out = new Map<string, { holder: string; expires_at: string }>();
  for (const [appId, l] of leases) {
    out.set(appId, { holder: maskEmail(emails.get(l.holder_user_id) ?? ''), expires_at: l.expires_at });
  }
  return out;
}

// ── list_apps / get_app ──────────────────────────────────────────────────────

export interface AppSummary {
  app_id: string;
  name: string;
  slug: string;
  workspace: string;
  preview_url: string;
  published_url?: string;
  published_version?: number;
  latest_version: number;
  compile_status: string | null;
  locked_by?: string;
  /** Taken down by a super-admin — nothing can be changed or published. */
  locked_by_admin?: true;
  /** The takedown category (with locked_by_admin). */
  locked_reason?: string;
}

async function summarize(rows: AppRow[], deps: ToolDeps): Promise<{
  items: AppSummary[];
  latest: Awaited<ReturnType<typeof latestVersions>>;
  locks: Map<string, { holder: string; expires_at: string }>;
}> {
  const ids = rows.map((r) => r.id);
  const [latest, published, leases] = await Promise.all([
    latestVersions(ids),
    versionNumbers(rows.map((r) => r.publishedVersionId).filter((v): v is string => !!v)),
    deps.leases.get(ids),
  ]);
  const locks = await lockInfo(leases);
  const items = rows.map((r) => {
    const v = latest.get(r.id);
    const item: AppSummary = {
      app_id: r.id,
      name: r.name ?? r.slug,
      slug: r.slug,
      workspace: r.workspaceSlug,
      preview_url: previewUrl(r.slug, deps.env),
      latest_version: v?.number ?? 0,
      compile_status: v?.compileStatus ?? null,
    };
    const pub = r.publishedVersionId ? published.get(r.publishedVersionId) : undefined;
    if (pub !== undefined) {
      item.published_url = publishedUrl(r.slug, deps.env);
      item.published_version = pub;
    }
    const lock = locks.get(r.id);
    if (lock) item.locked_by = lock.holder;
    if (r.lockedReason) {
      item.locked_by_admin = true;
      item.locked_reason = lockCategory(r.lockedReason);
    }
    return item;
  });
  return { items, latest, locks };
}

export async function listApps(ctx: CallContext, args: { workspace?: string }) {
  const { principal, deps } = ctx;
  let rows: AppRow[];
  if (args.workspace !== undefined) {
    const ws = await authorizeWorkspace(principal, args.workspace, 'viewer');
    rows = await appsInWorkspace(ws.id);
  } else {
    rows = await appsOfMember(principal.userId);
  }
  const workspaces = await listUserWorkspaces(principal.userId);
  const { items } = await summarize(rows, deps);
  const mine = await publishPermissions(
    workspaces.map((w) => w.id),
    { env: deps.env, actorUserId: principal.userId }
  );
  const result: {
    user: { email: string };
    workspaces: ({ slug: string; name: string; kind: string; role: string } & PublishOut)[];
    apps: AppSummary[];
    all_workspaces?: ({ slug: string; name: string; kind: string } & PublishOut)[];
    next?: string;
  } = {
    user: { email: principal.email },
    workspaces: workspaces.map((w) => ({ slug: w.slug, name: w.name, kind: w.kind, role: w.role, ...publishOut(mine.get(w.id)) })),
    apps: items,
  };
  if (principal.superAdmin) {
    const all = await listAllWorkspaces();
    const perms = await publishPermissions(all.map((w) => w.id), { env: deps.env });
    result.all_workspaces = all.map((w) => ({ slug: w.slug, name: w.name, kind: w.kind, ...publishOut(perms.get(w.id)) }));
  }
  result.next = listAppsNext(ctx.modules.skillList());
  return result;
}

interface PublishOut {
  can_publish: boolean;
  publish_contact?: string;
  publishing: WorkspacePublishing;
}

/** May the workspace publish, its state as a super-admin set it, and whom to ask when it may not. */
function publishOut(p: { allowed: boolean; contact: string | null; publishing: WorkspacePublishing } | undefined): PublishOut {
  if (!p) return { can_publish: true, publishing: 'default' };
  if (p.allowed) return { can_publish: true, publishing: p.publishing };
  return p.contact
    ? { can_publish: false, publish_contact: p.contact, publishing: p.publishing }
    : { can_publish: false, publishing: p.publishing };
}

export async function getApp(ctx: CallContext, args: { app_id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const { items, latest, locks } = await summarize([app], ctx.deps);
  const versions = await listVersions(app.id, { limit: 20 });
  const head = latest.get(app.id);
  const detail = head ? await getVersion(app.id, { id: head.id }) : null;
  const lock = locks.get(app.id);
  const enabled = await ctx.modules.enabledModules(app.workspaceId);
  const permission = (await publishPermissions([app.workspaceId], { env: ctx.deps.env, actorUserId: ctx.principal.userId })).get(
    app.workspaceId
  );
  const modules = await ctx.modules.appModules(
    { id: app.id, slug: app.slug, workspaceId: app.workspaceId },
    (m) => confirmUrl(ctx.modules.deps.env, app.workspaceSlug, app.slug, m),
    enabled
  );
  // The newest version's readiness report — with its type errors once the background check is done.
  const readiness = head ? await storedReadiness(ctx, app.id, enabled, head.number) : undefined;
  const render = head ? await renderSignal(ctx, app.id, head) : undefined;
  return {
    ...items[0],
    compile_errors: head?.compileStatus === 'error' ? toCompileOut(head.compileErrors, ctx.modules, enabled) : [],
    ...(readiness ? { readiness } : {}),
    ...(render ? { render } : {}),
    briefing: briefing(ctx, enabled),
    files: (detail?.files ?? [])
      .filter((f) => f.kind === 'source')
      .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    versions: versions.map((v) => ({
      number: v.number,
      created_at: v.createdAt.toISOString(),
      actor_kind: v.actorKind,
      reasoning: v.reasoning,
      compile_status: v.compileStatus,
    })),
    modules,
    skills: skills(ctx, enabled),
    gallery: await galleryOut(app, ctx.deps.env),
    ...(app.duplicatedFromSlug ? { duplicated_from: app.duplicatedFromSlug } : {}),
    // The custom domains in short; list_domains has the DNS records and the last check.
    domains: (await listDomains({ id: app.id, slug: app.slug, workspaceId: app.workspaceId }, ctx.deps.env)).map((d) => ({
      host: d.hostname,
      status: d.verified ? 'verified' : 'pending',
      primary: d.isPrimary,
    })),
    ...publishOut(permission),
    ...(lock ? { lock } : {}),
  };
}

/**
 * The render signal of a version (get_app, get_logs runtime): how many of
 * its pages loaded in a browser and how many browser errors they reported —
 * counts the beacon sent, nothing about the visitors. `beacon: false` = the
 * version's drobek.json turned the beacon off, so nothing is reported.
 */
export interface RenderSignal {
  version: number;
  beacon: boolean;
  page_loads: number;
  errors: number;
}

/** Does the version's drobek.json leave the beacon on? (An unreadable config counts as on, like the compiler's default.) */
async function beaconOn(versionId: string): Promise<boolean> {
  const bytes = await readVersionFile(versionId, CONFIG_FILE, 'source');
  if (!bytes) return true;
  return readAppConfig(new Map([[CONFIG_FILE, bytes.toString('utf8')]])).config.beacon;
}

async function renderSignal(ctx: CallContext, appId: string, version: { id: string; number: number }): Promise<RenderSignal> {
  if (!(await beaconOn(version.id))) return { version: version.number, beacon: false, page_loads: 0, errors: 0 };
  return { version: version.number, beacon: true, ...(await ctx.deps.logs.render(appId, version.number)) };
}

/** One sentence on the render signal for the get_logs note. */
function renderNote(r: RenderSignal): string {
  if (!r.beacon) return `Version ${r.version} has "beacon": false in drobek.json: its pages report nothing and nothing is counted.`;
  if (r.page_loads === 0) {
    return `No page of version ${r.version} has loaded in a browser yet — give the user the preview_url and call get_app or get_logs again after they opened it.`;
  }
  return `Version ${r.version}: ${r.page_loads} page load${r.page_loads === 1 ? '' : 's'}, ${r.errors} browser error${r.errors === 1 ? '' : 's'} reported by its pages.`;
}

/** get_app's `gallery`: the public gallery state and its likes / opens (30 days), read-only. */
async function galleryOut(app: AppRow, env: NodeJS.ProcessEnv) {
  if (!galleryEnabled(env)) return { enabled: false };
  const g = galleryState(app);
  const counts = await galleryCounts(app.id);
  return {
    enabled: true,
    listed: g.listed,
    description: g.description,
    hidden_by_admin: g.hiddenByAdmin,
    visible: g.visible,
    allow_duplicate: g.allowDuplicate,
    ...counts,
  };
}

// ── compile + store (create_app v1, write_files) ─────────────────────────────

function compileOut(r: Pick<CompileResult, 'ok' | 'errors' | 'warnings'>, modules: ModuleRuntime, enabled: ReadonlySet<string>) {
  return { ok: r.ok, errors: toCompileOut(r.errors, modules, enabled), warnings: toCompileOut(r.warnings, modules, enabled) };
}

/** Refuse (nothing stored) on a secret or a saturated compiler; everything else is stored. */
function refuseUnstorable(result: CompileResult): void {
  const secrets = result.errors.filter((e) => e.code === 'secret_in_source');
  if (secrets.length > 0) {
    throw new ToolError(
      'secret_in_source',
      `Refused: ${secrets.length} credential-looking value(s) in the files — nothing was stored.`,
      { compile: { ok: false, errors: toCompileOut(secrets), warnings: [] } }
    );
  }
  if (result.errors.some((e) => e.code === 'busy')) {
    throw new ToolError('busy', 'The compiler is busy — nothing was stored. Retry in a few seconds.');
  }
}

function versionFiles(sources: Map<string, string | Buffer>, result: CompileResult): VersionFileInput[] {
  const files: VersionFileInput[] = [...sources].map(([path, content]) => ({ path, content, kind: 'source' }));
  if (result.ok) {
    for (const [path, content] of result.outputs) files.push({ path, content, kind: 'built' });
  }
  return files;
}

/** One row of the compile history (get_logs 'compile') — best-effort, never fails the write. */
async function logCompile(
  ctx: CallContext,
  appId: string,
  versionNumber: number | null,
  result: CompileResult,
  trigger: 'create_app' | 'write_files'
): Promise<void> {
  try {
    await ctx.deps.logs.recordCompile({
      appId,
      versionNumber,
      ok: result.ok,
      errors: result.errors,
      warningCount: result.warnings.length,
      durationMs: result.durationMs,
      trigger,
    });
  } catch (err) {
    ctx.deps.log.warn('compile history write failed', { app_id: appId, error: dbErrorForLog(err) });
  }
}

async function compileAndStore(
  ctx: CallContext,
  app: { id: string; slug: string },
  sources: Map<string, string | Buffer>,
  reasoning: string,
  trigger: 'create_app' | 'write_files',
  baseVersion?: number | null
): Promise<{ number: number; result: CompileResult; typecheck?: 'pending' }> {
  // The bare `drobek` import → this server's versioned SDK (immutable caching);
  // `drobek/<module>` → that module's inline source, built into the app;
  // every entry loads the error beacon first (drobek.json can opt out).
  // The app's uploaded assets share its URL space: a reference to one is not missing.
  const assets = await listAssets(app.id);
  const result = await ctx.deps.compile(sources, {
    sdkUrl: ctx.modules.sdk.url,
    sdkSources: ctx.modules.sdk.inline,
    beaconUrl: ctx.modules.sdk.beacon.url,
    servedPaths: assets.map((a) => a.name),
  });
  try {
    refuseUnstorable(result);
  } catch (err) {
    await logCompile(ctx, app.id, null, result, trigger);
    throw err;
  }
  const { id, number } = await createVersion(app.id, versionFiles(sources, result), {
    actor: actorOf(ctx),
    reasoning,
    compile: { status: result.ok ? 'ok' : 'error', errors: result.ok ? null : result.errors },
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  });
  await logCompile(ctx, app.id, number, result, trigger);
  await ctx.deps.notifyAppChanged({ app_id: app.id, slug: app.slug, version: number });
  // The TypeScript check runs in the background — the write never waits for it.
  const typecheck = result.ok ? scheduleVersionTypecheck({ id, appId: app.id }, sources, ctx.deps.log) : undefined;
  return { number, result, ...(typecheck ? { typecheck } : {}) };
}

// ── create_app ───────────────────────────────────────────────────────────────

export async function createApp(
  ctx: CallContext,
  args: { name: string; workspace?: string; template?: TemplateName }
) {
  const name = String(args.name ?? '').trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new ToolError('invalid_params', `\`name\` must be 1–${NAME_MAX} characters.`);
  }
  if (scanForSecrets('name', name).length > 0) {
    throw new ToolError('invalid_params', '`name` looks like a credential — pick a plain name.');
  }
  const template: TemplateName = args.template ?? 'react-ts';

  const ws =
    args.workspace !== undefined
      ? await authorizeWorkspace(ctx.principal, args.workspace, 'editor')
      : await ensurePersonalWorkspace(ctx.principal.userId, ctx.principal.email);

  // Agent-friendly slug: derived from the name; too short/reserved/taken →
  // a free `-xxxx` variant instead of an error round trip.
  const base = deriveSlug(name);
  let slug = validateAppSlug(base) ? suggestSlug(base || 'app') : base;
  // The workspace's plan (limits provider) or the env default.
  const maxApps = (await ctx.modules.workspaceLimits(ws.id)).APPS_MAX_PER_WORKSPACE;
  let created: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    try {
      created = await createAppRow({ workspaceId: ws.id, slug, name, actor: actorOf(ctx), maxApps });
    } catch (err) {
      if (err instanceof AppsError && (err.code === 'slug_taken' || err.code === 'invalid_slug')) {
        slug = err.suggestion ?? suggestSlug(base || 'app');
        continue;
      }
      if (err instanceof AppsError && err.code === 'limit_exceeded') {
        throw new ToolError('limit_exceeded', err.message, { ...err.details });
      }
      throw err;
    }
  }
  if (!created) throw new ToolError('slug_taken', `Could not find a free slug for "${name}".`);

  const { number, result } = await compileAndStore(
    ctx,
    created,
    templateFiles(template, name),
    `Created from the ${template} template`,
    'create_app'
  );
  await ctx.modules.runHook('onAppCreate', { id: created.id, slug: created.slug, workspaceId: ws.id });
  const enabled = await ctx.modules.enabledModules(ws.id);
  return {
    app_id: created.id,
    name,
    slug: created.slug,
    workspace: ws.slug,
    template,
    version: number,
    compile: compileOut(result, ctx.modules, enabled),
    preview_url: previewUrl(created.slug, ctx.deps.env),
    briefing: briefing(ctx, enabled),
    skills: skills(ctx, enabled),
  };
}

// ── duplicate_app ────────────────────────────────────────────────────────────

/**
 * A gallery app's slug from `from`: a plain slug, or an address of THIS
 * server — an app host under APPS_DOMAIN (published, `--preview`, `--v<N>`),
 * a verified custom domain of a live app, or the dashboard's
 * `/duplicate/<slug>` page. Any other address is `invalid_params`, so an app
 * of another instance never resolves to a local app with the same slug.
 */
async function duplicateSourceSlug(from: string, env: NodeJS.ProcessEnv): Promise<string> {
  const raw = from.trim();
  if (!/[/.:]/.test(raw)) return raw.toLowerCase();
  const foreign = (what: string) =>
    new ToolError(
      'invalid_params',
      `\`from\` ${what}. Pass a gallery app of this server: its slug, its address (${publishedUrl('<slug>', env)}) or ${dashboardOrigin(env)}/duplicate/<slug>.`
    );
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw foreign('is neither a slug nor an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw foreign('must be an http(s) address');
  const config = hostConfig(env);
  if (url.host === config.dashboardHost) {
    const page = /^\/duplicate\/([^/]+)\/?$/.exec(url.pathname);
    if (!page) throw foreign('is a dashboard page other than /duplicate/<slug>');
    return decodeURIComponent(page[1]).toLowerCase();
  }
  const host = classifyHost(url.host, config);
  if (host.side === 'apps' && host.target) return host.target.slug;
  if (host.side === 'custom') {
    const custom = await resolveCustomHost(host.hostname);
    if (custom?.slug) return custom.slug;
  }
  throw foreign(`(${url.host}) is not an app address of this server`);
}

/**
 * Copy a gallery app into the caller's workspace — the dashboard's
 * /duplicate/:slug in one call. Only an app shown in the public gallery whose
 * owner allows duplicates; the copy is the published files as version 1 of a
 * new, unpublished app (provenance kept), and the source's module settings
 * are proposed to it through its confirmation flow (e-mail addresses,
 * proxy upstreams and sync sources dropped). Never secrets, data, users, uploads, assets or
 * domains. write scope, editor+ in the target workspace (default: personal).
 */
export async function duplicateApp(ctx: CallContext, args: { from: string; workspace?: string; name?: string }) {
  const env = ctx.deps.env;
  const from = await duplicateSourceSlug(String(args.from ?? ''), env);
  if (!from) throw new ToolError('invalid_params', '`from` must be a gallery app: its slug or its address.');
  if (args.name !== undefined && scanForSecrets('name', String(args.name)).length > 0) {
    throw new ToolError('invalid_params', '`name` looks like a credential — pick a plain name.');
  }
  const ws =
    args.workspace !== undefined
      ? await authorizeWorkspace(ctx.principal, args.workspace, 'editor')
      : await ensurePersonalWorkspace(ctx.principal.userId, ctx.principal.email);

  let copy: { id: string; slug: string; version: number };
  let source;
  try {
    source = await duplicationSource(from, env);
    const name = copyName(args.name, source);
    copy = await duplicateAppFiles({
      source,
      workspaceId: ws.id,
      name,
      actor: actorOf(ctx),
      maxApps: (await ctx.modules.workspaceLimits(ws.id)).APPS_MAX_PER_WORKSPACE,
      env,
    });
  } catch (err) {
    if (err instanceof AppsError) {
      if (err.code === 'not_found') throw new ToolError('not_found', err.message);
      if (err.code === 'invalid_settings') throw new ToolError('invalid_params', `name: ${err.message}`);
      if (
        err.code === 'not_duplicable' ||
        err.code === 'gallery_disabled' ||
        err.code === 'rate_limited' ||
        err.code === 'limit_exceeded' ||
        err.code === 'slug_taken'
      ) {
        throw new ToolError(err.code, err.message, { ...err.details });
      }
    }
    throw err;
  }
  await ctx.modules.runHook('onAppCreate', { id: copy.id, slug: copy.slug, workspaceId: ws.id });
  const modules = await duplicateModuleConfigs(ctx.modules, {
    sourceAppId: source.id,
    target: { id: copy.id, slug: copy.slug, workspaceId: ws.id, workspaceSlug: ws.slug },
    actorUserId: ctx.principal.userId,
    surface: 'mcp',
  });
  return {
    app_id: copy.id,
    slug: copy.slug,
    workspace: ws.slug,
    version: copy.version,
    from: source.slug,
    preview_url: previewUrl(copy.slug, env),
    modules,
    ...(modules.pending.length > 0
      ? { note: 'Some module settings wait for the user to confirm them on the new app (confirm_url). Tell the user; do not work around it.' }
      : {}),
  };
}

// ── write_files ──────────────────────────────────────────────────────────────

interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileChange {
  path: string;
  content?: string;
  delete?: boolean;
  /** Exact-string replacements applied to the file of the version the write builds on. */
  edits?: FileEdit[];
}

type ValidChange =
  | { path: string; content: string; edits?: undefined }
  | { path: string; content: null; edits?: undefined }
  | { path: string; content?: undefined; edits: FileEdit[] };

/** A note on a write that did not stop it; merged into the result's `warnings[]`. */
interface WriteWarning {
  code: 'edits_ignored';
  message: string;
  path: string;
}

function validateEdits(path: string, edits: unknown): FileEdit[] {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > WRITE_FILES_EDITS_MAX) {
    throw new ToolError(
      'invalid_params',
      `"${path}": \`edits\` must hold 1–${WRITE_FILES_EDITS_MAX} edits (got ${Array.isArray(edits) ? edits.length : 0}).`
    );
  }
  return edits.map((e: Partial<FileEdit> | null, i) => {
    if (typeof e?.old_string !== 'string' || e.old_string.length === 0 || typeof e.new_string !== 'string') {
      throw new ToolError(
        'invalid_params',
        `"${path}" edits[${i}]: pass a non-empty \`old_string\` and a \`new_string\` (both strings).`,
        { path, edit_index: i }
      );
    }
    if (e.replace_all !== undefined && typeof e.replace_all !== 'boolean') {
      throw new ToolError('invalid_params', `"${path}" edits[${i}]: \`replace_all\` must be true or false.`, { path, edit_index: i });
    }
    return { old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all === true };
  });
}

function validateChanges(files: unknown, reasoning: unknown, warnings: WriteWarning[]): ValidChange[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > WRITE_FILES_MAX) {
    const n = Array.isArray(files) ? files.length : 0;
    throw new ToolError(
      'invalid_params',
      `\`files\` must hold 1–${WRITE_FILES_MAX} changes per call (got ${n}). Split the change into several write_files calls.`
    );
  }
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0 || reasoning.length > REASONING_MAX_CHARS) {
    throw new ToolError('invalid_params', `\`reasoning\` must be 1–${REASONING_MAX_CHARS} characters.`);
  }
  const seen = new Set<string>();
  return (files as FileChange[]).map((f): ValidChange => {
    const path = normalizeAppPath(String(f?.path ?? ''));
    if (!path) throw new ToolError('invalid_path', `Unsafe file path ${JSON.stringify(f?.path)}.`);
    const del = f.delete === true;
    const hasContent = typeof f.content === 'string';
    // `edits` next to `content` / `delete` is ignored, with a warning.
    const edits = f.edits !== undefined && !del && !hasContent ? validateEdits(path, f.edits) : undefined;
    if (f.edits !== undefined && edits === undefined) {
      warnings.push({
        code: 'edits_ignored',
        path,
        message: `"${path}": \`edits\` was ignored because the entry also has ${del ? '`delete: true`' : '`content`'}. Send either the whole \`content\` or \`edits\`, not both.`,
      });
    }
    if (!edits && del === hasContent) {
      throw new ToolError(
        'invalid_params',
        `"${path}": pass either \`content\` (write), \`edits\` (change part of the file) or \`delete: true\` (remove), not both or neither.`
      );
    }
    if (!del && !TEXT_EXTS.has(extOf(path))) {
      throw new ToolError(
        'invalid_path',
        `"${path}": only text files can be written (${[...TEXT_EXTS].join(' ')}).`
      );
    }
    if (seen.has(path)) throw new ToolError('invalid_params', `"${path}" appears twice in one call.`);
    seen.add(path);
    if (edits) return { path, edits };
    return { path, content: del ? null : (f.content as string) };
  });
}

/** Non-overlapping occurrences of `needle` in `text`, left to right. */
function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

/** Apply one entry's edits in order, each to the result of the previous; the first that does not apply refuses the call. */
function applyEdits(path: string, before: string | Buffer | undefined, edits: FileEdit[], baseVersion: number | null): string {
  const mismatch = (i: number, reason: 'file_not_found' | 'not_found' | 'not_unique', message: string, extra: Record<string, unknown> = {}) =>
    new ToolError('edit_mismatch', `"${path}" edits[${i}]: ${message} Nothing was written.`, {
      path,
      edit_index: i,
      reason,
      base_version: baseVersion,
      ...extra,
    });
  if (typeof before !== 'string') {
    throw mismatch(0, 'file_not_found', `version ${baseVersion ?? 0} has no such text file — write a new file with \`content\`.`);
  }
  let text = before;
  edits.forEach((e, i) => {
    const at = occurrences(text, e.old_string);
    if (at.length === 0) throw mismatch(i, 'not_found', '`old_string` is not in the file (it must match exactly, whitespace included).');
    if (at.length > 1 && !e.replace_all) {
      throw mismatch(i, 'not_unique', `\`old_string\` matches ${at.length} times — add surrounding lines to make it unique, or set \`replace_all: true\`.`, {
        matches: at.length,
      });
    }
    let out = '';
    let from = 0;
    for (const p of e.replace_all ? at : at.slice(0, 1)) {
      out += text.slice(from, p) + e.new_string;
      from = p + e.old_string.length;
    }
    text = out + text.slice(from);
  });
  return text;
}

function checkSizes(files: Map<string, string | Buffer>, deps: ToolDeps): void {
  const L = deps.limits;
  if (files.size > L.maxFiles) {
    throw new ToolError('limit_exceeded', `${files.size} files exceeds the limit of ${L.maxFiles} files per app.`);
  }
  let total = 0;
  for (const [path, content] of files) {
    const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    if (bytes > L.maxFileBytes) {
      throw new ToolError(
        'limit_exceeded',
        `"${path}" is ${bytes} bytes; the per-file limit is ${L.maxFileBytes} bytes.`
      );
    }
    total += bytes;
  }
  if (total > L.maxTotalBytes) {
    throw new ToolError('limit_exceeded', `${total} bytes in total exceeds the per-app limit of ${L.maxTotalBytes} bytes.`);
  }
}

/** The latest version's number (null: none yet) and its source files (text as string, binary assets as Buffer). */
async function latestSources(appId: string): Promise<{ base: number | null; files: Map<string, string | Buffer> }> {
  const head = (await latestVersions([appId])).get(appId);
  const out = new Map<string, string | Buffer>();
  if (!head) return { base: null, files: out };
  const detail = await getVersion(appId, { id: head.id });
  const sources = (detail?.files ?? []).filter((f) => f.kind === 'source');
  const blobs = await readBlobs(sources.map((f) => f.sha256));
  for (const f of sources) {
    const bytes = blobs.get(f.sha256);
    if (!bytes) continue;
    out.set(f.path, TEXT_EXTS.has(extOf(f.path)) ? bytes.toString('utf8') : bytes);
  }
  return { base: head.number, files: out };
}

async function previewNote(appId: string, ok: boolean): Promise<Record<string, unknown>> {
  if (ok) return {};
  const last = await lastOkVersionNumber(appId);
  return {
    preview_version: last,
    note:
      last === null
        ? 'No version has compiled yet, so the preview has nothing to show. Fix compile.errors and write again.'
        : `The preview keeps serving version ${last} (the last one that compiled). Fix compile.errors and write again.`,
  };
}

/** Attempts of an edit-carrying write whose base version the same user's other session overtook. */
const EDIT_WRITE_ATTEMPTS = 3;

export async function writeFiles(
  ctx: CallContext,
  args: { app_id: string; files: FileChange[]; reasoning: string }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  refuseIfLockedByAdmin(app);
  const warnings: WriteWarning[] = [];
  const changes = validateChanges(args.files, args.reasoning, warnings);
  await takeLease(ctx, app.id);
  // The lease keeps other users out, not the same user's other session. Edits
  // are only valid against the version they were applied to, so a call with
  // edits is stored only on top of its base and re-applied to a newer one;
  // whole-file writes land on top of the latest version as they always did.
  const hasEdits = changes.some((c) => c.edits !== undefined);

  for (let attempt = 1; ; attempt++) {
    const { base, files } = await latestSources(app.id);
    const changed: string[] = [];
    for (const c of changes) {
      const before = files.get(c.path);
      if (c.edits !== undefined) {
        const after = applyEdits(c.path, before, c.edits, base);
        if (before !== after) changed.push(c.path);
        files.set(c.path, after);
      } else if (c.content === null) {
        if (before === undefined) {
          throw new ToolError('invalid_params', `Cannot delete "${c.path}": the latest version has no such file.`);
        }
        files.delete(c.path);
        changed.push(c.path);
      } else {
        if (before !== c.content) changed.push(c.path);
        files.set(c.path, c.content);
      }
    }
    checkSizes(files, ctx.deps);

    let stored: Awaited<ReturnType<typeof compileAndStore>>;
    try {
      stored = await compileAndStore(ctx, app, files, args.reasoning.trim(), 'write_files', hasEdits ? base : undefined);
    } catch (err) {
      if (!(err instanceof AppsError && err.code === 'version_conflict')) throw err;
      if (attempt >= EDIT_WRITE_ATTEMPTS) {
        throw new ToolError(
          'busy',
          'Another session kept storing new versions of this app while these edits were applied — nothing was stored. Retry in a few seconds.'
        );
      }
      continue;
    }
    const { number, result, typecheck } = stored;
    const enabled = await ctx.modules.enabledModules(app.workspaceId);
    const compile = compileOut(result, ctx.modules, enabled);
    return {
      version: number,
      base_version: base,
      compile,
      preview_url: previewUrl(app.slug, ctx.deps.env),
      changed,
      readiness: await filesReadiness(ctx, app.id, enabled, files, compile.errors, typecheck),
      ...(await previewNote(app.id, result.ok)),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

// ── restore_version ──────────────────────────────────────────────────────────

export async function restoreVersion(ctx: CallContext, args: { app_id: string; version: number }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  refuseIfLockedByAdmin(app);
  if (!Number.isInteger(args.version) || args.version < 1) {
    throw new ToolError('invalid_params', '`version` must be a positive integer.');
  }
  await takeLease(ctx, app.id);
  let created: { id: string; number: number; assetsRestored: boolean };
  try {
    created = await restore(app.id, args.version, actorOf(ctx));
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_found') {
      throw new ToolError('not_found', `Version ${args.version} does not exist.`);
    }
    throw err;
  }
  const v = await getVersion(app.id, { id: created.id });
  const ok = v?.compileStatus === 'ok';
  await ctx.deps.notifyAppChanged({ app_id: app.id, slug: app.slug, version: created.number });
  return {
    version: created.number,
    restored_from: args.version,
    // True = the draft assets were reset to the set that version had when it was last published.
    assets_restored: created.assetsRestored,
    compile: {
      ok,
      errors: ok ? [] : toCompileOut(v?.compileErrors, ctx.modules, await ctx.modules.enabledModules(app.workspaceId)),
      warnings: [],
    },
    preview_url: previewUrl(app.slug, ctx.deps.env),
    ...(await previewNote(app.id, ok)),
  };
}

// ── publish ──────────────────────────────────────────────────────────────────

/**
 * Put a version live on the production host `<slug>.<APPS_DOMAIN>` — default
 * the newest version that compiled; an older `version` IS the production
 * rollback. Only `ok` versions are publishable (not_publishable otherwise).
 * editor+ (same floor as writing). No single-writer lease: publish writes no
 * files and cannot interleave with a write — it only moves one pointer
 * (atomic, audited `app.publish` by @drobek/apps). A workspace a super-admin
 * blocked answers `publish_blocked`; an unapproved one (PUBLISH_APPROVAL=
 * approval) `publish_not_approved`, and that refusal already
 * e-mailed the operator an approval request.
 */
export async function publishApp(ctx: CallContext, args: { app_id: string; version?: number }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  refuseIfLockedByAdmin(app);
  if (args.version !== undefined && (!Number.isInteger(args.version) || args.version < 1)) {
    throw new ToolError('invalid_params', '`version` must be a positive integer.');
  }
  const number = args.version ?? (await lastOkVersionNumber(app.id));
  if (number === null) {
    throw new ToolError(
      'not_publishable',
      'No version of this app has compiled yet, so there is nothing to publish. Fix compile.errors with write_files first.'
    );
  }
  const version = await getVersion(app.id, { number });
  if (!version) throw new ToolError('not_found', `Version ${number} does not exist.`);

  let result: { number: number; previousNumber: number | null; assets: 'draft' | 'kept' };
  try {
    result = await publishVersion(app.id, version.id, actorOf(ctx), { env: ctx.deps.env });
  } catch (err) {
    if (err instanceof AppsError && (err.code === 'publish_not_approved' || err.code === 'publish_blocked')) {
      throw publishRefused(err.code, err.message, err.contact);
    }
    if (err instanceof AppsError && err.code === 'not_publishable') {
      throw new ToolError('not_publishable', err.message, { version: number });
    }
    if (err instanceof AppsError && err.code === 'not_found') {
      throw new ToolError('not_found', `Version ${number} does not exist.`);
    }
    throw err;
  }
  await ctx.deps.notifyAppChanged({ app_id: app.id, slug: app.slug, version: result.number, kind: 'publish' });
  await ctx.modules.runHook('onPublish', { id: app.id, slug: app.slug, workspaceId: app.workspaceId, version: result.number });
  const url = publishedUrl(app.slug, ctx.deps.env);
  // Warnings only — a version that compiled is published whatever they say.
  const readiness = await storedReadiness(ctx, app.id, await ctx.modules.enabledModules(app.workspaceId), result.number);
  return {
    published_version: result.number,
    previous_version: result.previousNumber,
    published_url: url,
    // The production host, then every VERIFIED custom domain — all serve this version now.
    domains: [new URL(url).host, ...(await verifiedDomainsOf(app.id))],
    // Which asset set went live with it — the draft (what the preview shows) or, for a
    // rollback, the set the version had when it was last published.
    assets: result.assets === 'draft' ? 'draft' : 'as_last_published',
    ...(readiness ? { readiness } : {}),
  };
}

// ── set_gallery_listing ──────────────────────────────────────────────────────

/**
 * List a PUBLISHED app in the server's public gallery with a short public
 * description, change the description, or unlist it — the same
 * @drobek/apps function as the dashboard switch, audited as the agent.
 * publish scope (tools/list), editor+ role. Listing refuses, in this order: a
 * server without a gallery (`gallery_disabled`), a taken-down app, an entry
 * the operator hid (`gallery_hidden`), an unpublished app (`not_published`),
 * a bad description (`invalid_params`) and — last, so the agent never asks
 * the user about a listing that cannot happen — a call without
 * `user_confirmed: true` (`user_confirmation_required`). Unlisting needs no
 * confirmation. `allow_duplicate` (listing only; omitted keeps it) rides on
 * the listing's confirmation.
 */
export async function setGalleryListingTool(
  ctx: CallContext,
  args: { app_id: string; listed: boolean; description?: string; allow_duplicate?: boolean; user_confirmed?: boolean }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const env = ctx.deps.env;
  if (!galleryEnabled(env)) {
    throw new ToolError('gallery_disabled', 'This server has no public gallery (GALLERY_ENABLED is off).');
  }
  if (typeof args.listed !== 'boolean') throw new ToolError('invalid_params', '`listed` must be true or false.');
  if (args.allow_duplicate !== undefined && typeof args.allow_duplicate !== 'boolean') {
    throw new ToolError('invalid_params', '`allow_duplicate` must be true or false.');
  }
  const name = app.name ?? app.slug;
  if (args.listed) {
    refuseIfLockedByAdmin(app);
    if (app.galleryHiddenAt) {
      throw new ToolError('gallery_hidden', 'The server operator hid this app from the public gallery; it cannot be listed there.');
    }
    if (!app.publishedVersionId) {
      throw new ToolError('not_published', `"${name}" is not published, and only a published app can be listed in the gallery.`);
    }
    const v = normalizeGalleryDescription(args.description);
    if (!v.ok) throw new ToolError('invalid_params', `description: ${v.message}`);
    if (args.user_confirmed !== true) {
      throw new ToolError(
        'user_confirmation_required',
        `Listing "${name}" in the public gallery shows it to everyone${args.allow_duplicate ? ' and lets any signed-in person copy its published files into their own workspace' : ''}. Ask the user whether they want "${name}" in the public gallery with this description${args.allow_duplicate ? ' and open to duplicates' : ''}, and call again with user_confirmed: true only after they say yes.`,
        { description: v.value, ...(args.allow_duplicate !== undefined ? { allow_duplicate: args.allow_duplicate } : {}) }
      );
    }
  }
  let result;
  try {
    result = await setGalleryListing(
      app.id,
      args.listed
        ? { listed: true, description: String(args.description), ...(args.allow_duplicate !== undefined ? { allowDuplicate: args.allow_duplicate } : {}) }
        : { listed: false },
      actorOf(ctx),
      { env }
    );
  } catch (err) {
    if (err instanceof AppsError) {
      if (err.code === 'not_found') throw notFound('app');
      if (err.code === 'invalid_settings') throw new ToolError('invalid_params', `description: ${err.message}`);
      if (err.code === 'not_published' || err.code === 'gallery_hidden' || err.code === 'gallery_disabled') {
        throw new ToolError(err.code, err.message);
      }
    }
    throw err;
  }
  const state = galleryState({ ...app, galleryListed: result.listed, galleryDescription: result.description, galleryAllowDuplicate: result.allowDuplicate });
  return {
    app_id: app.id,
    listed: result.listed,
    description: result.description,
    allow_duplicate: result.allowDuplicate,
    changed: result.changed,
    visible: state.visible,
    ...(result.listed && app.visibility === 'password'
      ? { note: 'The app is password-protected: the gallery shows it only once the owner makes it public on the app\'s Settings tab in the dashboard.' }
      : {}),
  };
}

// ── skill_info ───────────────────────────────────────────────────────────────

/**
 * The agent-facing documentation of this server's backends:
 * `skill_info()` lists every skill (active modules + general skills) with its
 * "use when…" sentence; `skill_info(name)` returns one skill's Markdown (for a
 * module also its SDK types, config schema/defaults, limits and the NAMES of
 * its secrets). Server-wide: it never returns a secret value or any app's
 * config. An opt-in module's skill carries `availability: 'opt-in'`; with
 * `app_id` (viewer+ of that app) it also says `enabled_for_workspace` — is
 * the module active for the app's workspace.
 */
export async function skillInfo(ctx: CallContext, args: { name?: string; app_id?: string }) {
  let enabled: ReadonlySet<string> | null = null;
  if (args.app_id !== undefined && args.app_id !== '') {
    const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
    enabled = await ctx.modules.enabledModules(app.workspaceId);
  }
  const list = ctx.modules.skillList().map((s) =>
    enabled && s.availability === 'opt-in' ? { ...s, enabled_for_workspace: enabled.has(s.name) } : s
  );
  if (args.name === undefined || args.name === '') {
    return {
      skills: list,
      note:
        list.length === 0
          ? 'This server has no platform modules and no skills: build self-contained front-ends (state in the browser).'
          : 'Call skill_info with a name before using that backend; follow the skill exactly.',
    };
  }
  const info = ctx.modules.skillInfo(String(args.name));
  if (!info) {
    throw new ToolError('not_found', `No skill "${String(args.name)}" on this server.`, {
      available: list.map((s) => s.name),
      hint: 'skill_info()',
    });
  }
  if (enabled && info.availability === 'opt-in') info.enabled_for_workspace = enabled.has(info.name);
  return info;
}

// ── configure_module ─────────────────────────────────────────────────────────

/**
 * Set a platform module's per-app config. `config` is a PARTIAL
 * config (JSON merge patch: only the keys you change; null resets a key).
 * Validated against the module's configSchema (`invalid_params` with the
 * field paths). Changes the module marks as needing the owner's OK (e.g.
 * opening data to the public, a new e-mail recipient) are held as pending:
 * `applied:false`, `pending_confirmation`, `confirm_url` for the user; a
 * proposal made while another waits joins it (`merged_with_pending`).
 * editor+; takes the single-writer lease like write_files.
 */
export async function configureModule(
  ctx: CallContext,
  args: { app_id: string; module: string; config: unknown }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (typeof args.module !== 'string' || args.module.length === 0) {
    throw new ToolError('invalid_params', '`module` must be the name of a platform module (see skill_info()).');
  }
  refuseIfLockedByAdmin(app);
  await takeLease(ctx, app.id);
  try {
    const out = await ctx.modules.configure({
      app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId, workspaceSlug: app.workspaceSlug },
      module: args.module,
      patch: args.config,
      actorUserId: ctx.principal.userId,
    });
    return {
      ...out,
      ...(out.pending_confirmation.length > 0
        ? {
            note:
              'Give the user confirm_url and tell them what needs their confirmation. The pending change applies only after they confirm it in the drobek dashboard; until then the config above stays in force.' +
              (out.merged_with_pending
                ? ' A change was already waiting (merged_with_pending): this proposal joined it, so pending_confirmation lists the combined change, and the user confirms or rejects it all at once.'
                : '') +
              (out.confirm_role === 'admin' ? ' Only a workspace admin of the app\'s workspace can confirm this one (confirm_role: admin).' : ''),
          }
        : {}),
      ...(out.secrets_missing?.length
        ? { secrets_note: 'The app owner sets these secrets in the drobek dashboard — never ask for their values, never put them in files or config.' }
        : {}),
    };
  } catch (err) {
    if (isModuleError(err) && (err.code === 'invalid_params' || err.code === 'not_found' || err.code === 'module_not_enabled')) {
      const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
      const code = err.code === 'not_found' ? 'not_found' : err.code === 'module_not_enabled' ? 'module_not_enabled' : 'invalid_params';
      throw new ToolError(code, err.message, {
        ...details,
        ...(err.hint ? { hint: err.hint } : {}),
      });
    }
    throw err;
  }
}

// ── query_data ───────────────────────────────────────────────────────────────

const QUERY_DATA_DEFAULT_LIMIT = 20;
const QUERY_DATA_MAX_LIMIT = 100;

export interface QueryDataResult {
  app_id: string;
  collection: string;
  records: Record<string, unknown>[];
  total: number;
  next_cursor: string | null;
  untrusted: true;
}

/**
 * Read an app's stored records as its owner: viewer+ of the app's
 * workspace, authorized per call; the end-user rules do not apply. The
 * records module (the built-in `data`) answers for THIS app only, so another
 * app's collections are simply not found. ≤ 100 records per call; the
 * records are end-user input (`untrusted`).
 */
export async function queryData(
  ctx: CallContext,
  args: { app_id: string; collection: string; filter?: unknown; sort?: string; dir?: string; limit?: number; cursor?: string }
): Promise<QueryDataResult> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  if (typeof args.collection !== 'string' || args.collection.length === 0) {
    throw new ToolError('invalid_params', '`collection` must be the name of a collection of the app (get_app lists the data config).');
  }
  const limit = args.limit ?? QUERY_DATA_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_DATA_MAX_LIMIT) {
    throw new ToolError('invalid_params', `\`limit\` must be an integer from 1 to ${QUERY_DATA_MAX_LIMIT}.`);
  }
  if (args.dir !== undefined && args.dir !== 'asc' && args.dir !== 'desc') {
    throw new ToolError('invalid_params', '`dir` must be "asc" or "desc".');
  }
  const records = await ctx.modules.records({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
  if (!records) {
    throw new ToolError('not_found', 'This server has no data module: apps here store no records.', { hint: 'skill_info()' });
  }
  try {
    const page = await records.query({
      collection: args.collection,
      filter: args.filter,
      sort: args.sort,
      dir: args.dir as 'asc' | 'desc' | undefined,
      limit,
      cursor: args.cursor ?? null,
    });
    return {
      app_id: app.id,
      collection: args.collection,
      records: page.records,
      total: page.total,
      next_cursor: page.next_cursor,
      untrusted: true,
    };
  } catch (err) {
    if (isModuleError(err) && err.code === 'not_found') {
      const available = (await records.collections()).map((c) => c.name);
      throw new ToolError('not_found', err.message, { available, hint: `skill_info('${records.module}')` });
    }
    if (isModuleError(err) && err.code === 'invalid_request') {
      throw new ToolError('invalid_params', err.message, { hint: `skill_info('${records.module}')` });
    }
    throw err;
  }
}

// ── get_logs ─────────────────────────────────────────────────────────────────

/** get_logs kinds: the insights logs plus `sync` (the sync module's run history). */
type GetLogsKind = LogKind | 'sync';
const GET_LOGS_KINDS: readonly GetLogsKind[] = [...LOG_KINDS, 'sync'];
const GET_LOGS_MAX = 100;

export interface GetLogsResult {
  app_id: string;
  kind: GetLogsKind;
  /** The start of the window the entries cover (ISO; at most 30 days back). */
  since: string;
  entries: unknown[];
  untrusted: true;
  /** kind runtime: the newest version's page loads and browser errors. */
  render?: RenderSignal;
  note?: string;
}

const EMPTY_NOTES: Record<GetLogsKind, string> = {
  runtime:
    'No browser errors in this window. Every page that loads a compiled entry reports uncaught errors, unhandled promise rejections, files that failed to load and requests the CSP blocked here within seconds (unless drobek.json has "beacon": false) — open the preview_url to reproduce a problem, then call get_logs again.',
  compile: 'No compiles in this window.',
  requests: 'No requests in this window.',
  sync: 'No sync runs in this window. A source runs on its schedule once the owner confirmed it; sync_now runs it at once.',
};

/**
 * What happened to an app, for the viewer+ of its workspace:
 *   runtime  — browser errors reported by the app's pages (deduped, with counts,
 *              each with the version of its page) + the newest version's render
 *              signal (page loads, errors of its pages);
 *   compile  — the last 50 compiles (ok / errors / version / duration);
 *   requests — per UTC day: requests, 5xx, 404s, and module calls by status class;
 *   sync     — the latest runs of the app's sync sources (newest first).
 * `since` (ISO) narrows the window; nothing older than 30 days exists. ≤ 100
 * entries. Everything is app-authored or user-supplied text → `untrusted`.
 */
export async function getLogs(
  ctx: CallContext,
  args: { app_id: string; kind: string; since?: string }
): Promise<GetLogsResult> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const kind = args.kind as GetLogsKind;
  if (!(GET_LOGS_KINDS as readonly string[]).includes(kind)) {
    throw new ToolError('invalid_params', '`kind` must be "runtime", "compile", "requests" or "sync".');
  }
  if (args.since !== undefined && (typeof args.since !== 'string' || Number.isNaN(Date.parse(args.since)))) {
    throw new ToolError('invalid_params', '`since` must be an ISO 8601 date-time, e.g. "2026-09-23T10:00:00Z".');
  }
  const from = logsWindowStart(args.since ?? null);
  if (kind === 'sync') {
    const sync = await ctx.modules.sync({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
    const runs = sync ? await sync.runs({ since: from, limit: GET_LOGS_MAX }) : [];
    return {
      app_id: app.id,
      kind,
      since: from.toISOString(),
      entries: runs,
      untrusted: true,
      ...(runs.length === 0 ? { note: sync ? EMPTY_NOTES.sync : 'This server has no sync module: apps here import nothing on a schedule.' } : {}),
    };
  }
  if (kind === 'runtime') {
    const entries: RuntimeEntry[] = await ctx.deps.logs.runtime(app.id, from);
    const head = (await latestVersions([app.id])).get(app.id);
    const render = head ? await renderSignal(ctx, app.id, head) : undefined;
    const note = [entries.length === 0 ? EMPTY_NOTES.runtime : null, render ? renderNote(render) : null].filter(Boolean).join(' ');
    return {
      app_id: app.id,
      kind,
      since: from.toISOString(),
      entries,
      untrusted: true,
      ...(render ? { render } : {}),
      ...(note ? { note } : {}),
    };
  }
  const entries = kind === 'compile' ? await ctx.deps.logs.compile(app.id, from) : await ctx.deps.logs.requests(app.id, from);
  return {
    app_id: app.id,
    kind,
    since: from.toISOString(),
    entries,
    untrusted: true,
    ...(entries.length === 0 ? { note: EMPTY_NOTES[kind] } : {}),
  };
}

// ── sync_now ─────────────────────────────────────────────────────────────────

/**
 * Run one of the app's sync sources now, the dashboard's Run now
 * over MCP: editor+, a paused source too (a successful run resumes one paused
 * after failures). A failed RUN is not a tool error: the answer is the run
 * with `status: "failed"` and its `error`. Rate limited per source
 * (SYNC_NOW_PER_MINUTE) and by the app's hourly runs; audited `sync.run`
 * with the agent as the actor.
 */
const SYNC_NOW_PASSED_CODES = ['not_found', 'module_not_enabled', 'rate_limited', 'limit_exceeded'] as const;

export async function syncNow(ctx: CallContext, args: { app_id: string; source: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (typeof args.source !== 'string' || args.source.length === 0) {
    throw new ToolError('invalid_params', '`source` must be the name of a sync source of the app (get_app lists them under modules.sync).');
  }
  refuseIfLockedByAdmin(app);
  const sync = await ctx.modules.sync({ id: app.id, slug: app.slug, workspaceId: app.workspaceId });
  if (!sync) {
    throw new ToolError('not_found', 'This server has no sync module: apps here import nothing on a schedule.', { hint: 'skill_info()' });
  }
  try {
    const run = await sync.runNow(args.source, { userId: ctx.principal.userId, surface: 'mcp' });
    return {
      app_id: app.id,
      run,
      ...(run.status === 'failed'
        ? { note: `The run failed and changed nothing: ${run.error ?? 'see get_logs(kind: "sync")'}. skill_info('${sync.module}') maps the usual errors to their fix.` }
        : {}),
    };
  } catch (err) {
    if (isModuleError(err)) {
      const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
      const hint = { hint: `skill_info('${sync.module}')` };
      const passed = SYNC_NOW_PASSED_CODES.find((c) => c === err.code);
      if (passed) throw new ToolError(passed, err.message, { ...details, ...hint });
      if (err.code === 'conflict') throw new ToolError('busy', err.message, { ...details, reason: 'sync_running', ...hint });
    }
    throw err;
  }
}
