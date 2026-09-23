/**
 * The MCP tool bodies (plan §4): list_apps, create_app, get_app, read_file,
 * write_files, restore_version (M0-05), publish (M0-06), skill_info and
 * configure_module (M1-01). Each takes the caller + validated
 * arguments and returns a plain JSON payload or throws a ToolError; the MCP
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
 *    credential-looking values. Only the dashboard sets them.
 */
import {
  APP_LOCK_TTL_SEC,
  REASONING_MAX_CHARS,
  WRITE_FILES_MAX,
  renderBriefing,
} from '@drobek/agent-dx';
import {
  AppsError,
  createApp as createAppRow,
  createVersion,
  deriveSlug,
  getVersion,
  listVersions,
  previewUrl,
  publish as publishVersion,
  publishedUrl,
  readBlobs,
  readVersionFile,
  restore,
  suggestSlug,
  validateAppSlug,
  type Actor,
  type VersionFileInput,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { maskEmail } from '@drobek/auth';
import {
  BINARY_EXTS,
  TEXT_EXTS,
  normalizeAppPath,
  scanForSecrets,
  type CompileMessage,
  type CompileResult,
} from '@drobek/compile';
import { confirmUrl, isModuleError, type ModuleRuntime, type SkillListItem } from '@drobek/modules';
import { ensurePersonalWorkspace, listUserWorkspaces } from '@drobek/tenancy';
import { authorizeApp, authorizeWorkspace } from './access.js';
import type { ToolDeps, ToolPrincipal } from './context.js';
import { ToolError } from './errors.js';
import type { Lease } from './lease.js';
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

export interface CallContext {
  principal: ToolPrincipal;
  /** MCP session id — recorded in the lease (the same user may take it over). */
  sessionId: string;
  deps: ToolDeps;
  /** The platform modules + skills of this process (resolved once per call). */
  modules: ModuleRuntime;
}

const NAME_MAX = 80;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function actorOf(ctx: CallContext): Actor {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') };
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i <= path.lastIndexOf('/') ? '' : path.slice(i).toLowerCase();
}

/**
 * `{ code, file, line, column, text, hint? }` — the agent-facing compile
 * message. `hint` (M1-01) points a backend import the platform replaces at its
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

function toCompileOut(messages: unknown, modules?: ModuleRuntime): CompileErrorOut[] {
  if (!Array.isArray(messages)) return [];
  return (messages as Partial<CompileMessage>[]).map((m) => {
    const out: CompileErrorOut = {
      code: String(m.code ?? 'build_error'),
      file: m.file ?? null,
      line: m.line ?? null,
      column: m.column ?? null,
      text: String(m.text ?? ''),
    };
    const hint = modules?.compileHint({ code: out.code, specifier: m.specifier });
    if (hint) out.hint = hint;
    return out;
  });
}

function briefing(ctx: CallContext): string {
  const L = ctx.deps.limits;
  return renderBriefing({
    limits: {
      maxFiles: L.maxFiles,
      maxFileBytes: L.maxFileBytes,
      maxTotalBytes: L.maxTotalBytes,
      timeoutMs: L.timeoutMs,
    },
    skills: ctx.modules.skillList(),
  });
}

function skills(ctx: CallContext): SkillListItem[] {
  return ctx.modules.skillList();
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
  return {
    user: { email: principal.email },
    workspaces: workspaces.map((w) => ({ slug: w.slug, name: w.name, kind: w.kind, role: w.role })),
    apps: items,
  };
}

export async function getApp(ctx: CallContext, args: { app_id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const { items, latest, locks } = await summarize([app], ctx.deps);
  const versions = await listVersions(app.id, { limit: 20 });
  const head = latest.get(app.id);
  const detail = head ? await getVersion(app.id, { id: head.id }) : null;
  const lock = locks.get(app.id);
  const modules = await ctx.modules.appModules(app.id, (m) => confirmUrl(ctx.modules.deps.env, app.workspaceSlug, app.slug, m));
  return {
    ...items[0],
    compile_errors: head?.compileStatus === 'error' ? toCompileOut(head.compileErrors, ctx.modules) : [],
    briefing: briefing(ctx),
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
    skills: skills(ctx),
    ...(lock ? { lock } : {}),
  };
}

// ── read_file ────────────────────────────────────────────────────────────────

export interface ReadFileResult {
  path: string;
  version: number;
  untrusted: true;
  content?: string;
  binary?: true;
  size?: number;
}

export async function readFile(
  ctx: CallContext,
  args: { app_id: string; path: string; version?: number }
): Promise<ReadFileResult> {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  if (args.version !== undefined && (!Number.isInteger(args.version) || args.version < 1)) {
    throw new ToolError('invalid_params', '`version` must be a positive integer.');
  }
  const path = normalizeAppPath(String(args.path ?? ''));
  if (!path) throw new ToolError('invalid_path', `Unsafe file path ${JSON.stringify(args.path)}.`);

  const number = args.version ?? (await latestVersions([app.id])).get(app.id)?.number;
  const version = number ? await getVersion(app.id, { number }) : null;
  if (!version) {
    throw new ToolError('not_found', number ? `Version ${number} does not exist.` : 'The app has no versions yet.');
  }
  const file = version.files.find((f) => f.kind === 'source' && f.path === path);
  if (!file) throw new ToolError('not_found', `No file "${path}" in version ${version.number}.`);
  const bytes = await readVersionFile(version.id, path, 'source');
  if (!bytes) throw new ToolError('not_found', `No file "${path}" in version ${version.number}.`);

  if (!BINARY_EXTS.has(extOf(path))) {
    try {
      return { path, version: version.number, untrusted: true, content: utf8.decode(bytes) };
    } catch {
      // not UTF-8 → report as binary below
    }
  }
  return { path, version: version.number, untrusted: true, binary: true, size: bytes.length };
}

// ── compile + store (create_app v1, write_files) ─────────────────────────────

function compileOut(r: Pick<CompileResult, 'ok' | 'errors' | 'warnings'>, modules?: ModuleRuntime) {
  return { ok: r.ok, errors: toCompileOut(r.errors, modules), warnings: toCompileOut(r.warnings, modules) };
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

async function compileAndStore(
  ctx: CallContext,
  app: { id: string; slug: string },
  sources: Map<string, string | Buffer>,
  reasoning: string
): Promise<{ number: number; result: CompileResult }> {
  // The bare `drobek` import → this server's versioned SDK (immutable caching);
  // `drobek/<module>` → that module's inline source, built into the app (M1-02).
  const result = await ctx.deps.compile(sources, { sdkUrl: ctx.modules.sdk.url, sdkSources: ctx.modules.sdk.inline });
  refuseUnstorable(result);
  const { number } = await createVersion(app.id, versionFiles(sources, result), {
    actor: actorOf(ctx),
    reasoning,
    compile: { status: result.ok ? 'ok' : 'error', errors: result.ok ? null : result.errors },
  });
  await ctx.deps.notifyAppChanged({ app_id: app.id, slug: app.slug, version: number });
  return { number, result };
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
  let created: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    try {
      created = await createAppRow({ workspaceId: ws.id, slug, name, actor: actorOf(ctx) });
    } catch (err) {
      if (err instanceof AppsError && (err.code === 'slug_taken' || err.code === 'invalid_slug')) {
        slug = err.suggestion ?? suggestSlug(base || 'app');
        continue;
      }
      throw err;
    }
  }
  if (!created) throw new ToolError('slug_taken', `Could not find a free slug for "${name}".`);

  const { number, result } = await compileAndStore(
    ctx,
    created,
    templateFiles(template, name),
    `Created from the ${template} template`
  );
  await ctx.modules.runHook('onAppCreate', { id: created.id, slug: created.slug, workspaceId: ws.id });
  return {
    app_id: created.id,
    name,
    slug: created.slug,
    workspace: ws.slug,
    template,
    version: number,
    compile: compileOut(result, ctx.modules),
    preview_url: previewUrl(created.slug, ctx.deps.env),
    briefing: briefing(ctx),
    skills: skills(ctx),
  };
}

// ── write_files ──────────────────────────────────────────────────────────────

export interface FileChange {
  path: string;
  content?: string;
  delete?: boolean;
}

interface ValidChange {
  path: string;
  content: string | null;
}

function validateChanges(files: unknown, reasoning: unknown): ValidChange[] {
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
  return (files as FileChange[]).map((f) => {
    const path = normalizeAppPath(String(f?.path ?? ''));
    if (!path) throw new ToolError('invalid_path', `Unsafe file path ${JSON.stringify(f?.path)}.`);
    const del = f.delete === true;
    if (del === (typeof f.content === 'string')) {
      throw new ToolError(
        'invalid_params',
        `"${path}": pass either \`content\` (write) or \`delete: true\` (remove), not both or neither.`
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
    return { path, content: del ? null : (f.content as string) };
  });
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

/** The latest version's source files (text as string, binary assets as Buffer). */
async function latestSources(appId: string): Promise<Map<string, string | Buffer>> {
  const head = (await latestVersions([appId])).get(appId);
  const out = new Map<string, string | Buffer>();
  if (!head) return out;
  const detail = await getVersion(appId, { id: head.id });
  const sources = (detail?.files ?? []).filter((f) => f.kind === 'source');
  const blobs = await readBlobs(sources.map((f) => f.sha256));
  for (const f of sources) {
    const bytes = blobs.get(f.sha256);
    if (!bytes) continue;
    out.set(f.path, TEXT_EXTS.has(extOf(f.path)) ? bytes.toString('utf8') : bytes);
  }
  return out;
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

export async function writeFiles(
  ctx: CallContext,
  args: { app_id: string; files: FileChange[]; reasoning: string }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const changes = validateChanges(args.files, args.reasoning);
  await takeLease(ctx, app.id);

  const files = await latestSources(app.id);
  const changed: string[] = [];
  for (const c of changes) {
    const before = files.get(c.path);
    if (c.content === null) {
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

  const { number, result } = await compileAndStore(ctx, app, files, args.reasoning.trim());
  return {
    version: number,
    compile: compileOut(result, ctx.modules),
    preview_url: previewUrl(app.slug, ctx.deps.env),
    changed,
    ...(await previewNote(app.id, result.ok)),
  };
}

// ── restore_version ──────────────────────────────────────────────────────────

export async function restoreVersion(ctx: CallContext, args: { app_id: string; version: number }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (!Number.isInteger(args.version) || args.version < 1) {
    throw new ToolError('invalid_params', '`version` must be a positive integer.');
  }
  await takeLease(ctx, app.id);
  let created: { id: string; number: number };
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
    compile: {
      ok,
      errors: ok ? [] : toCompileOut(v?.compileErrors, ctx.modules),
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
 * (atomic, audited `app.publish` by @drobek/apps).
 */
export async function publishApp(ctx: CallContext, args: { app_id: string; version?: number }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
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

  let result: { number: number; previousNumber: number | null };
  try {
    result = await publishVersion(app.id, version.id, actorOf(ctx));
  } catch (err) {
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
  return {
    published_version: result.number,
    previous_version: result.previousNumber,
    published_url: url,
    domains: [new URL(url).host],
  };
}

// ── skill_info ───────────────────────────────────────────────────────────────

/**
 * The agent-facing documentation of this server's backends (M1-01):
 * `skill_info()` lists every skill (active modules + general skills) with its
 * "use when…" sentence; `skill_info(name)` returns one skill's Markdown (for a
 * module also its SDK types, config schema/defaults, limits and the NAMES of
 * its secrets). Server-wide, app-independent: it never returns a secret value
 * or any app's config.
 */
export async function skillInfo(ctx: CallContext, args: { name?: string }) {
  const list = ctx.modules.skillList();
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
  return info;
}

// ── configure_module ─────────────────────────────────────────────────────────

/**
 * Set a platform module's per-app config (M1-01). `config` is a PARTIAL
 * config (JSON merge patch: only the keys you change; null resets a key).
 * Validated against the module's configSchema (`invalid_params` with the
 * field paths). Changes the module marks as needing the owner's OK (e.g.
 * opening data to the public, a new e-mail recipient) are held as pending:
 * `applied:false`, `pending_confirmation`, `confirm_url` for the user.
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
            note: 'Give the user confirm_url and tell them what needs their confirmation. The pending change applies only after they confirm it in the drobek dashboard; until then the config above stays in force.',
          }
        : {}),
      ...(out.secrets_missing?.length
        ? { secrets_note: 'The app owner sets these secrets in the drobek dashboard — never ask for their values, never put them in files or config.' }
        : {}),
    };
  } catch (err) {
    if (isModuleError(err) && (err.code === 'invalid_params' || err.code === 'not_found')) {
      const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
      throw new ToolError(err.code === 'not_found' ? 'not_found' : 'invalid_params', err.message, {
        ...details,
        ...(err.hint ? { hint: err.hint } : {}),
      });
    }
    throw err;
  }
}
