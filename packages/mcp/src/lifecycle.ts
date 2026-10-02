/**
 * The app lifecycle tools (MCP parity with the dashboard's app page and
 * Settings tab): unpublish, set_visibility, set_frame_ancestors,
 * release_lease and delete_app. Every body calls the SAME @drobek/apps
 * function as the dashboard's `appAction` (`unpublishApp`, `setAppVisibility`,
 * `setFrameAncestors`, `releaseAppLease`, `softDeleteApp` — each writes its
 * audit row, here as the agent), with the same role floor (editor+), and
 * announces the change (`notifyAppChanged`) so the app hosts' serve cache
 * drops the app at once; delete_app also runs the modules' `onAppDelete`.
 *
 * What changes the public site needs the user's explicit yes
 * (`user_confirmed: true`, checked last so the agent never asks about a call
 * that cannot happen): unpublishing, deleting, and making a password-protected
 * app public. An app password never passes through MCP: `password` only
 * re-applies a password the owner set in the dashboard (`password_not_set`
 * with the Settings link otherwise). release_lease frees only the caller's
 * own lease; another user's stays (`app_locked`). A taken-down app refuses
 * unpublish like the dashboard (`app_locked_by_admin`); the rest stays
 * possible there too.
 */
import {
  AppsError,
  dashboardOrigin,
  galleryEnabled,
  publishedUrl,
  setAppVisibility,
  setFrameAncestors,
  softDeleteApp,
  unpublishApp,
  type Actor,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { verifiedDomainsOf } from '@drobek/domains';
import { DEFAULT_FRAME_ANCESTORS, parseFrameAncestors } from '@drobek/serving';
import { authorizeApp } from './access.js';
import { ToolError, lockedByAdmin, notFound } from './errors.js';
import type { AppRow } from './queries.js';
import { appLocked, type CallContext } from './tools.js';

function actorOf(ctx: CallContext): Actor & { userId: string } {
  return { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') };
}

function nameOf(app: AppRow): string {
  return app.name ?? app.slug;
}

/** The app's Settings tab in the dashboard (visibility, password, embedding, delete). */
function settingsUrl(ctx: CallContext, app: AppRow): string {
  return `${dashboardOrigin(ctx.deps.env)}/workspaces/${encodeURIComponent(app.workspaceSlug)}/apps/${encodeURIComponent(app.slug)}/settings`;
}

/** An app deleted between the authorization and the change answers like any unknown app. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_found') throw notFound('app');
    throw err;
  }
}

async function changed(ctx: CallContext, app: AppRow, kind: 'unpublish' | 'settings' | 'delete'): Promise<void> {
  await ctx.deps.notifyAppChanged({ app_id: app.id, slug: app.slug, kind });
}

// ── unpublish ────────────────────────────────────────────────────────────────

export async function unpublishTool(ctx: CallContext, args: { app_id: string; user_confirmed?: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  const name = nameOf(app);
  if (!app.publishedVersionId) {
    throw new ToolError('not_published', `"${name}" is not published: its production address already answers "not published".`);
  }
  const url = publishedUrl(app.slug, ctx.deps.env);
  const listed = app.galleryListed && galleryEnabled(ctx.deps.env);
  if (args.user_confirmed !== true) {
    const domains = await verifiedDomainsOf(app.id);
    throw new ToolError(
      'user_confirmation_required',
      `Unpublishing "${name}" takes it off ${[url, ...domains].join(', ')}: visitors get "not published" from the next request (the preview and the version hosts keep serving${listed ? '; it also leaves the public gallery' : ''}). Ask the user whether to unpublish "${name}", and call again with user_confirmed: true only after they say yes.`,
      { published_url: url, domains }
    );
  }
  let out: { previousNumber: number };
  try {
    out = await run(() => unpublishApp(app.id, actorOf(ctx)));
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_published') throw new ToolError('not_published', err.message);
    throw err;
  }
  await changed(ctx, app, 'unpublish');
  return {
    app_id: app.id,
    unpublished_version: out.previousNumber,
    gallery_unlisted: listed,
    note: `${url} and the app's custom domains answer "not published" now; the preview keeps serving. publish puts a version live again — only when the user asks.`,
  };
}

// ── set_visibility ───────────────────────────────────────────────────────────

export async function setVisibilityTool(
  ctx: CallContext,
  args: { app_id: string; visibility: 'public' | 'password'; user_confirmed?: boolean }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (args.visibility !== 'public' && args.visibility !== 'password') {
    throw new ToolError('invalid_params', '`visibility` must be "public" or "password".');
  }
  const name = nameOf(app);
  const settings = settingsUrl(ctx, app);
  if (args.visibility === 'public' && app.visibility !== 'public' && args.user_confirmed !== true) {
    const listed = app.galleryListed && galleryEnabled(ctx.deps.env);
    throw new ToolError(
      'user_confirmation_required',
      `"${name}" is password-protected: only people with its password can open it. Making it public lets anyone with the link open every address of it (the production address, the preview and the version hosts)${listed ? ' and shows it in the public gallery again, where it is listed' : ''}, and removes its password — protecting it again needs a new one, set in the dashboard. Ask the user whether "${name}" should be public, and call again with user_confirmed: true only after they say yes.`,
      { visibility: 'public' }
    );
  }
  let out: { changed: boolean };
  try {
    out = await run(() => setAppVisibility(app.id, { visibility: args.visibility }, actorOf(ctx)));
  } catch (err) {
    if (err instanceof AppsError && err.code === 'invalid_settings') {
      throw new ToolError(
        'password_not_set',
        `"${name}" has no password, and a password never passes through MCP: the owner chooses Password on the app's Settings tab in the dashboard (settings_url) and sets one there. Never ask for it in chat.`,
        { settings_url: settings }
      );
    }
    throw err;
  }
  if (out.changed) await changed(ctx, app, 'settings');
  if (args.visibility === 'public') {
    return {
      app_id: app.id,
      visibility: 'public' as const,
      changed: out.changed,
      note: out.changed ? `Anyone with the link can open "${name}" now, on every address of it.` : `"${name}" is already public.`,
    };
  }
  return {
    app_id: app.id,
    visibility: 'password' as const,
    changed: out.changed,
    settings_url: settings,
    note: `Only people with the password can open "${name}"${out.changed ? ' now' : ''}. The owner changes the password on the app's Settings tab (settings_url), never through MCP.`,
  };
}

// ── set_frame_ancestors ──────────────────────────────────────────────────────

export async function setFrameAncestorsTool(ctx: CallContext, args: { app_id: string; frame_ancestors: string | null }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (args.frame_ancestors !== null && typeof args.frame_ancestors !== 'string') {
    throw new ToolError('invalid_params', '`frame_ancestors` must be a space-separated list of origins, or null.');
  }
  const raw = (args.frame_ancestors ?? '').trim();
  let value: string | null = null;
  if (raw) {
    const parsed = parseFrameAncestors(raw);
    if (!parsed) {
      throw new ToolError(
        'invalid_params',
        "`frame_ancestors`: use 'self' and/or up to 10 http(s) origins separated by spaces, e.g. https://intranet.example.com (a host may start with *.; no path, no other quote, no bare *).",
        { frame_ancestors: raw }
      );
    }
    value = parsed === DEFAULT_FRAME_ANCESTORS ? null : parsed;
  }
  const out = await run(() => setFrameAncestors(app.id, value, actorOf(ctx)));
  if (out.changed) await changed(ctx, app, 'settings');
  return {
    app_id: app.id,
    frame_ancestors: value,
    previous: app.frameAncestors,
    changed: out.changed,
    note: value
      ? `These may embed the app in an <iframe> on every host of it: ${value}. Every other site is still refused.`
      : 'No other site may embed the app.',
  };
}

// ── release_lease ────────────────────────────────────────────────────────────

export async function releaseLeaseTool(ctx: CallContext, args: { app_id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const out = await ctx.deps.leases.release({ id: app.id, slug: app.slug, workspaceId: app.workspaceId }, actorOf(ctx));
  if (!out.released && out.previous) {
    throw await appLocked(out.previous, ' release_lease frees only your own lease, so this one stays.');
  }
  return {
    app_id: app.id,
    released: out.released,
    note: out.released
      ? 'The write lease is free: another member\'s agent can write now. Your next write takes it again.'
      : 'Nobody held the write lease of this app.',
  };
}

// ── delete_app ───────────────────────────────────────────────────────────────

export async function deleteAppTool(ctx: CallContext, args: { app_id: string; user_confirmed?: boolean }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  const name = nameOf(app);
  if (args.user_confirmed !== true) {
    const live = app.publishedVersionId ? [publishedUrl(app.slug, ctx.deps.env), ...(await verifiedDomainsOf(app.id))] : [];
    throw new ToolError(
      'user_confirmation_required',
      `Deleting "${name}" (${app.slug}) takes every address of it offline at once — ${live.length > 0 ? `${live.join(', ')}, ` : ''}the preview and every version host answer 404 — and removes it from the dashboard and from MCP; neither the user nor you can bring it back. Ask the user whether to delete "${name}", and call again with user_confirmed: true only after they say yes.`,
      { app_id: app.id, slug: app.slug, name, published: Boolean(app.publishedVersionId) }
    );
  }
  const out = await run(() => softDeleteApp(app.id, actorOf(ctx)));
  await changed(ctx, app, 'delete');
  // Platform modules clean up after the app (best effort, errors logged).
  await ctx.modules.runHook('onAppDelete', { id: app.id, slug: app.slug, workspaceId: app.workspaceId });
  return {
    deleted: app.slug,
    app_id: app.id,
    slug_released_at: out.slugReleaseAt.toISOString(),
    note: `Every address of "${name}" answers 404 now. The slug ${app.slug} stays reserved until ${out.slugReleaseAt.toISOString().slice(0, 10)}; then a new app may take it.`,
  };
}
