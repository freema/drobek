/**
 * The super-admin tools next to set_workspace_publishing (MCP parity with
 * the dashboard's Workspace → Modules switch and the moderation queue
 * /admin/abuse): set_workspace_module, takedown_app, restore_app and
 * set_gallery_hidden. Registered only for a super-admin's grant
 * (register.ts); every body refuses anyone else too.
 *
 * Each calls the SAME function as the dashboard (@drobek/modules
 * setWorkspaceModule, @drobek/apps takedownApp / restoreApp /
 * setGalleryHidden + the owners' e-mail), audited with the agent as the
 * actor. A change needs `user_confirmed: true` — the super-admin's explicit
 * yes; a call that would change nothing answers `changed: false` without it.
 * The moderation tools take the app by its app_id, its slug or one of its
 * addresses (an app host or a verified custom domain), so the host named in
 * an abuse report is enough.
 */
import { eq } from 'drizzle-orm';
import {
  LOCK_REASONS,
  findAppByReportedHost,
  findModerationApp,
  hostConfig,
  isLockReason,
  lockCategory,
  mailOwnersAboutModeration,
  normalizeReportHost,
  publishedUrl,
  reasonLabel,
  restoreApp,
  setGalleryHidden,
  takedownApp,
  takedownPreview,
  type ReportedApp,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { apps, getDb } from '@drobek/db';
import { isModuleError, type WorkspaceModuleState } from '@drobek/modules';
import { authorizeWorkspace } from './access.js';
import { ToolError, notFound } from './errors.js';
import type { CallContext } from './tools.js';

const AGENT = actorKindForSurface('mcp');

function requireSuperAdmin(ctx: CallContext, what: string): void {
  if (!ctx.principal.superAdmin) throw new ToolError('forbidden', `Only a super-admin of this server can ${what}.`);
}

function confirm(message: string, details: Record<string, unknown>): never {
  throw new ToolError('user_confirmation_required', `${message} Call again with user_confirmed: true only after they say yes.`, details);
}

// ── set_workspace_module ─────────────────────────────────────────────────────

function moduleOut(workspace: string, s: WorkspaceModuleState, changed: boolean, dependentsOff: string[]) {
  const decided = s.source === 'plan' || s.source === 'env';
  return {
    workspace,
    module: s.name,
    switch: s.dashboard.enabled,
    enabled: s.enabled,
    source: s.source,
    missing_requires: s.missing_requires,
    required_by: s.required_by,
    changed,
    dependents_off: dependentsOff,
    ...(decided && s.dashboard.enabled !== s.enabled
      ? {
          note:
            s.source === 'plan'
              ? `The workspace's plan (MODULE_ENABLED_${s.name.toUpperCase()}) decides "${s.name}" and wins over the switch.`
              : `The server's MODULE_ENABLED_${s.name.toUpperCase()}=1 enables "${s.name}" on every workspace, whatever the switch says.`,
        }
      : {}),
  };
}

export async function setWorkspaceModuleTool(
  ctx: CallContext,
  args: { workspace: string; module: string; enabled: boolean; user_confirmed?: boolean }
) {
  requireSuperAdmin(ctx, 'enable or disable an opt-in module for a workspace');
  if (typeof args.enabled !== 'boolean') throw new ToolError('invalid_params', '`enabled` must be true or false.');
  const ws = await authorizeWorkspace(ctx.principal, String(args.workspace ?? ''), 'viewer');
  const name = String(args.module ?? '');
  const states = await ctx.modules.workspaceModules(ws.id);
  const state = states.find((m) => m.name === name);
  if (!state) {
    throw new ToolError('not_found', `No opt-in platform module "${name}" is active on this server.`, { available: states.map((m) => m.name) });
  }
  if (state.dashboard.enabled === args.enabled) return moduleOut(ws.slug, state, false, []);
  if (args.enabled && state.missing_requires.length > 0) {
    const list = state.missing_requires.map((m) => `"${m}"`);
    throw new ToolError(
      'module_requires_not_enabled',
      `The module "${name}" depends on ${list.join(', ')}, which ${list.length > 1 ? 'are' : 'is'} not enabled for workspace "${ws.slug}". Nothing changed.`,
      { module: name, missing: state.missing_requires }
    );
  }
  if (args.user_confirmed !== true) {
    const off = state.required_by.length > 0 ? ` It also turns off ${state.required_by.map((m) => `"${m}"`).join(', ')}, which depend${state.required_by.length > 1 ? '' : 's'} on it.` : '';
    confirm(
      args.enabled
        ? `Enabling "${name}" for workspace "${ws.slug}" lets every app there use it (its skill, configure_module and its routes). Ask the user whether to enable "${name}" for "${ws.slug}".`
        : `Disabling "${name}" for workspace "${ws.slug}" turns it off for every app there at once: its routes answer module_not_enabled and configure_module refuses it.${off} Ask the user whether to disable "${name}" for "${ws.slug}".`,
      { workspace: ws.slug, module: name, enabled: args.enabled, required_by: state.required_by }
    );
  }
  let out: { changed: boolean; dependentsOff: string[] };
  try {
    out = await ctx.modules.setWorkspaceModule({
      workspaceId: ws.id,
      module: name,
      enabled: args.enabled,
      actorUserId: ctx.principal.userId,
      surface: 'mcp',
    });
  } catch (err) {
    if (isModuleError(err) && (err.code === 'module_requires_not_enabled' || err.code === 'not_found')) {
      const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
      throw new ToolError(err.code === 'not_found' ? 'not_found' : 'module_requires_not_enabled', err.message, details);
    }
    throw err;
  }
  const after = (await ctx.modules.workspaceModules(ws.id)).find((m) => m.name === name) ?? state;
  return moduleOut(ws.slug, after, out.changed, out.dependentsOff);
}

// ── the moderation queue ─────────────────────────────────────────────────────

/** The live app `raw` names: its app_id, its slug, or one of its addresses (app host, verified custom domain, a URL). */
async function moderationApp(ctx: CallContext, raw: unknown): Promise<ReportedApp> {
  const value = String(raw ?? '').trim();
  if (value && !/[/.:]/.test(value)) {
    const byId = await findModerationApp(value);
    if (byId) return byId;
  }
  const host = normalizeReportHost(value);
  if (!host) throw new ToolError('invalid_params', '`app` must be the app\'s app_id, its slug or one of its addresses (e.g. shop.example.com).');
  const config = hostConfig(ctx.deps.env);
  const app = await findAppByReportedHost(host.includes('.') ? host : `${host}.${config.appsDomain}`, config);
  if (!app) throw notFound('app');
  return app;
}

function appOut(app: ReportedApp) {
  return { app_id: app.id, app: app.slug, workspace: app.workspaceSlug };
}

export async function takedownAppTool(ctx: CallContext, args: { app: string; reason: string; user_confirmed?: boolean }) {
  requireSuperAdmin(ctx, 'take an app down');
  if (!isLockReason(args.reason)) throw new ToolError('invalid_params', `\`reason\` must be one of ${LOCK_REASONS.join(', ')}.`);
  const reason = args.reason;
  const app = await moderationApp(ctx, args.app);
  if (app.lockedReason !== null) {
    const current = lockCategory(app.lockedReason);
    return {
      ...appOut(app),
      taken_down: true,
      reason: current,
      changed: false,
      owners_emailed: 0,
      note: `${app.slug} is already taken down (${reasonLabel(current)}). Nothing changed; restore_app first if the reason is wrong.`,
    };
  }
  if (args.user_confirmed !== true) {
    const p = await takedownPreview(app.id);
    const domains = p?.domains ?? [];
    const hosts = [app.published ? publishedUrl(app.slug, ctx.deps.env) : null, 'its preview and version addresses', ...domains].filter(Boolean);
    confirm(
      `Taking ${app.slug} (workspace "${app.workspaceSlug}") down for ${reasonLabel(reason)} unpublishes it, makes ${hosts.join(', ')} answer 451 "unavailable", blocks every change by its owners and their agents until it is restored${
        p && p.openReports > 0 ? `, resolves its ${p.openReports} open report${p.openReports === 1 ? '' : 's'}` : ''
      }${p?.galleryListed ? ', removes it from the public gallery' : ''} and e-mails its owners the reason. Ask the user whether to take ${app.slug} down for ${reason}.`,
      { ...appOut(app), reason, published: app.published, domains, open_reports: p?.openReports ?? 0, gallery_listed: p?.galleryListed ?? false }
    );
  }
  const out = await takedownApp({ appId: app.id, reason, actorUserId: ctx.principal.userId, actorKind: AGENT, log: ctx.deps.log });
  let mailed = 0;
  if (out.changed) {
    ctx.deps.log.warn('app taken down by a super-admin', {
      event: 'admin_takedown',
      app_id: app.id,
      slug: app.slug,
      reason,
      unpublished_version_id: out.unpublishedVersionId,
      surface: 'mcp',
    });
    mailed = await mailOwnersAboutModeration({ kind: 'takedown', app, reason }, ctx.deps.log, ctx.deps.env);
  }
  return {
    ...appOut(app),
    taken_down: true,
    reason,
    changed: out.changed,
    owners_emailed: mailed,
    note: `${app.slug} is taken down: every address answers 451 and it cannot be changed or published. restore_app lifts it; the app then stays unpublished until its owner publishes.`,
  };
}

export async function restoreAppTool(ctx: CallContext, args: { app: string; user_confirmed?: boolean }) {
  requireSuperAdmin(ctx, 'restore a taken-down app');
  const app = await moderationApp(ctx, args.app);
  if (app.lockedReason === null) {
    return { ...appOut(app), taken_down: false, changed: false, owners_emailed: 0, note: `${app.slug} is not taken down. Nothing changed.` };
  }
  const reason = lockCategory(app.lockedReason);
  if (args.user_confirmed !== true) {
    confirm(
      `Restoring ${app.slug} (workspace "${app.workspaceSlug}", taken down for ${reasonLabel(reason)}) lifts the takedown: its owners and their agents can change it again and its preview and version addresses serve again. It stays unpublished until its owner publishes, and its owners are e-mailed. Ask the user whether to restore ${app.slug}.`,
      { ...appOut(app), reason }
    );
  }
  const out = await restoreApp({ appId: app.id, actorUserId: ctx.principal.userId, actorKind: AGENT, log: ctx.deps.log });
  let mailed = 0;
  if (out.wasLocked) {
    ctx.deps.log.warn('app restored by a super-admin', { event: 'admin_restore', app_id: app.id, slug: app.slug, reason: out.reason, surface: 'mcp' });
    mailed = await mailOwnersAboutModeration({ kind: 'restore', app, reason: out.reason ?? 'other' }, ctx.deps.log, ctx.deps.env);
  }
  return {
    ...appOut(app),
    taken_down: false,
    changed: out.wasLocked,
    owners_emailed: mailed,
    note: `${app.slug} is restored. It stays unpublished until its owner publishes.`,
  };
}

export async function setGalleryHiddenTool(ctx: CallContext, args: { app: string; hidden: boolean; user_confirmed?: boolean }) {
  requireSuperAdmin(ctx, 'hide an app in the public gallery');
  if (typeof args.hidden !== 'boolean') throw new ToolError('invalid_params', '`hidden` must be true or false.');
  const app = await moderationApp(ctx, args.app);
  const [row] = await getDb()
    .select({ hiddenAt: apps.galleryHiddenAt, listed: apps.galleryListed })
    .from(apps)
    .where(eq(apps.id, app.id))
    .limit(1);
  if (!row) throw notFound('app');
  const out = (changed: boolean) => ({
    ...appOut(app),
    hidden: args.hidden,
    listed: row.listed,
    changed,
    note: args.hidden
      ? `${app.slug} is hidden from the public gallery; neither its owner nor an agent can list it until it is shown again.`
      : `${app.slug} may be shown in the public gallery again${row.listed ? '' : ' once its owner lists it'}.`,
  });
  if ((row.hiddenAt !== null) === args.hidden) return out(false);
  if (args.user_confirmed !== true) {
    confirm(
      args.hidden
        ? `Hiding ${app.slug} (workspace "${app.workspaceSlug}") takes it off the public gallery at once, and its owner cannot list it until it is shown again. Ask the user whether to hide ${app.slug}.`
        : `Showing ${app.slug} (workspace "${app.workspaceSlug}") again lets the gallery list it${row.listed ? ' at once (its owner listed it)' : ' when its owner lists it'}. Ask the user whether to show ${app.slug} again.`,
      { ...appOut(app), hidden: args.hidden, listed: row.listed }
    );
  }
  const changed = await setGalleryHidden(app.id, args.hidden, ctx.principal.userId, { actorKind: AGENT });
  ctx.deps.log.warn(args.hidden ? 'gallery entry hidden by a super-admin' : 'gallery entry shown again by a super-admin', {
    event: args.hidden ? 'admin_gallery_hide' : 'admin_gallery_show',
    app_id: app.id,
    slug: app.slug,
    changed: changed.changed,
    surface: 'mcp',
  });
  return out(changed.changed);
}
