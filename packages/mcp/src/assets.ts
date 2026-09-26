/**
 * The asset tools (NSO-358): create_asset_upload, list_assets, delete_asset.
 *
 * write_files is text-only, and a 26 MB video must never pass through an LLM
 * as base64. So create_asset_upload hands out an UPLOAD URL instead: a
 * single-use capability on the dashboard host (`PUT /api/assets/upload/<token>`,
 * 30 minutes, bound to the app, the path, the declared size and type family and
 * the calling user — @drobek/apps tokens.server.ts). The agent runs the `curl`
 * line it gets in its own sandbox, or gives the link to the user (a browser
 * GET on it shows an upload page). The bytes then go straight to drobek,
 * which sniffs, caps and stores them; the app serves them at `/<path>` —
 * the same path the page already uses (`<video src="film.mp4">`).
 *
 * NSO-362: an upload, a replacement or a delete changes the app's DRAFT
 * assets — the preview shows it at once, the production URL only after
 * `publish` (which needs the publish scope and the user's explicit request).
 * list_assets says per asset whether production already serves it.
 *
 * Every check that needs no bytes runs HERE, before a URL exists: the path
 * rule, no app file at that path (`asset_path_taken`), the declared type fits
 * the extension, the size cap (APP_ASSET_MAX_BYTES) and the app's quota
 * (APP_ASSETS_QUOTA), both from the workspace's limits; and the per-app
 * budget of upload URLs (APP_ASSET_UPLOADS_PER_HOUR). The PUT repeats them
 * against the real bytes. Write scope + editor role for the two changing
 * tools, read scope + viewer for list_assets. A taken-down app refuses both.
 */
import {
  assetLimitsOf,
  assetPath,
  assetUsage,
  assetUploadUrl,
  checkAssetUpload,
  createUploadToken,
  curlUploadCommand,
  dashboardOrigin,
  deleteAsset,
  isAssetsError,
  listAssets,
  listPublishedOnlyAssets,
  previewUrl,
  type AssetDisk,
  type UploadTokenStore,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { authorizeApp } from './access.js';
import { ToolError, lockedByAdmin, type ToolErrorCode } from './errors.js';
import type { AppRow } from './queries.js';
import type { CallContext } from './tools.js';

/** The asset seams of ToolDeps (Redis + ASSETS_DIR in production, memory + a temp dir in tests). */
export interface AssetDeps {
  /** Where upload tokens live (hashed, TTL). */
  tokens: UploadTokenStore;
  /** Counts one upload URL against the app's hourly budget; false = over it. */
  uploadAllowed(appId: string): Promise<boolean>;
  disk: AssetDisk;
}

const PASSTHROUGH: ReadonlySet<string> = new Set<ToolErrorCode>([
  'invalid_params',
  'asset_too_large',
  'asset_type_not_allowed',
  'asset_quota_exceeded',
  'asset_path_taken',
  'asset_not_found',
  'not_found',
]);

function toolErrorOf(err: unknown, app: AppRow): unknown {
  if (!isAssetsError(err)) return err;
  if (err.code === 'app_locked_by_admin') return lockedByAdmin(app.lockedReason);
  if (PASSTHROUGH.has(err.code)) return new ToolError(err.code as ToolErrorCode, err.message, err.details);
  return err;
}

/** `film.mp4` or `/film.mp4` → `film.mp4` (the list shows paths with the leading slash). */
function assetName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/^\//, '') : '';
}

async function limitsFor(ctx: CallContext, app: AppRow) {
  return assetLimitsOf(await ctx.modules.workspaceLimits(app.workspaceId), ctx.deps.env);
}

export async function createAssetUpload(
  ctx: CallContext,
  args: { app_id: string; path: string; size: number; content_type?: string }
) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  const name = assetName(args.path);
  const contentType = typeof args.content_type === 'string' ? args.content_type.trim() : '';
  const limits = await limitsFor(ctx, app);
  try {
    await checkAssetUpload({ appId: app.id, name, size: args.size, contentType, limits });
  } catch (err) {
    throw toolErrorOf(err, app);
  }
  if (!(await ctx.deps.assets.uploadAllowed(app.id))) {
    throw new ToolError('rate_limited', 'This app has used up its upload URLs for this hour (APP_ASSET_UPLOADS_PER_HOUR).', {
      limit: 'APP_ASSET_UPLOADS_PER_HOUR',
    });
  }
  const { token, expiresAt } = await createUploadToken(
    ctx.deps.assets.tokens,
    {
      appId: app.id,
      appSlug: app.slug,
      workspaceId: app.workspaceId,
      name,
      size: args.size,
      contentType,
      userId: ctx.principal.userId,
      actorKind: actorKindForSurface('mcp'),
      via: 'mcp',
    },
    ctx.deps.now
  );
  const url = assetUploadUrl(dashboardOrigin(ctx.modules.deps.env), token);
  return {
    upload_url: url,
    method: 'PUT',
    expires_at: expiresAt.toISOString(),
    max_bytes: limits.maxBytes,
    asset_path: assetPath(name),
    asset_url: `${previewUrl(app.slug, ctx.deps.env)}${assetPath(name)}`,
    curl: curlUploadCommand(url),
    note: 'Single use, valid 30 minutes. Run the curl line with the real file (its size must be exactly `size` bytes), or give the link to the user — opening it in a browser shows an upload page. Once the upload answers 201 the preview serves the file at asset_path; the production URL serves it after the next publish.',
  };
}

export async function listAssetsTool(ctx: CallContext, args: { app_id: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'viewer');
  const [assets, publishedOnly, used, limits] = await Promise.all([
    listAssets(app.id),
    listPublishedOnlyAssets(app.id),
    assetUsage(app.id),
    limitsFor(ctx, app),
  ]);
  return {
    app_id: app.id,
    assets: assets.map((a) => ({ path: a.path, type: a.type, size: a.size, updated_at: a.updatedAt.toISOString(), published: a.published })),
    // Deleted from the draft, still on the production URL until the next publish.
    published_only: publishedOnly.map((a) => a.path),
    changes_pending_publish: publishedOnly.length > 0 || assets.some((a) => !a.published),
    used_bytes: used,
    quota_bytes: limits.quota,
    max_bytes: limits.maxBytes,
  };
}

export async function deleteAssetTool(ctx: CallContext, args: { app_id: string; path: string }) {
  const { app } = await authorizeApp(ctx.principal, args.app_id, 'editor');
  if (app.lockedReason) throw lockedByAdmin(app.lockedReason);
  const name = assetName(args.path);
  const removed = await deleteAsset({
    app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId },
    name,
    actor: { userId: ctx.principal.userId, kind: actorKindForSurface('mcp') },
    via: 'mcp',
    disk: ctx.deps.assets.disk,
  });
  if (!removed) {
    throw new ToolError('asset_not_found', `This app has no asset at ${assetPath(name)}.`, { path: assetPath(name) });
  }
  return { deleted: assetPath(name), note: 'Gone from the preview now; a published app keeps serving it until the next publish.' };
}
