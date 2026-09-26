/**
 * GET/POST /workspaces/:slug/apps/:appSlug/assets — server half of the Assets
 * tab (NSO-358): the app's own binary files (video, audio, images, fonts)
 * served at `/<path>` next to its files — the dashboard side of
 * create_asset_upload / list_assets / delete_asset (UI and MCP parity).
 *
 * GET (viewer+): every asset (path, sniffed type, size, time, a link on the
 * preview host) and the usage against APP_ASSETS_QUOTA / APP_ASSET_MAX_BYTES
 * (the workspace's limits).
 *
 * POST (editor+):
 *   - `intent=upload-url` (`path`, `size`, `type`): the same checks as the MCP
 *     tool, then a single-use upload URL bound to the app, the path, the size
 *     and this user (audited as theirs when the PUT lands). The page's script
 *     PUTs the chosen file to it straight away (with a progress bar); without
 *     script the page shows the link (a browser upload page) and a curl line.
 *     The bytes never pass through this action.
 *   - `intent=delete` (`path`, after a confirm step): removes the asset
 *     (audited `asset.delete`).
 * A taken-down app refuses both (423).
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  assetLimitsOf,
  assetPath,
  assetUploadAllowed,
  assetUploadUrl,
  assetUsage,
  checkAssetUpload,
  createUploadToken,
  curlUploadCommand,
  dashboardOrigin,
  deleteAsset,
  isAssetsError,
  listAssets,
  previewUrl,
  redisUploadTokenStore,
  type UploadTokenStore,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { appHeaderFor } from '../app-page.server.js';
import { loadAppForView } from '../apps.server.js';
import { formatBytes } from '../owner-view.js';

/** The seams of the Assets tab (Redis in production; tests swap them). */
export const assetsTabDeps: {
  tokens: () => UploadTokenStore;
  uploadAllowed: (appId: string) => Promise<boolean>;
  env: () => NodeJS.ProcessEnv;
} = {
  tokens: () => redisUploadTokenStore(),
  uploadAllowed: (appId) => assetUploadAllowed(appId),
  env: () => process.env,
};

async function appOf(workspaceId: string, appSlug: string) {
  const app = await loadAppForView(workspaceId, appSlug);
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  return app;
}

async function limitsOf(workspaceId: string) {
  return assetLimitsOf(await (await moduleRuntime()).workspaceLimits(workspaceId), assetsTabDeps.env());
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await appOf(access.workspace.id, String(params.appSlug ?? ''));
  const url = new URL(request.url);
  const [assets, used, limits] = await Promise.all([listAssets(app.id), assetUsage(app.id), limitsOf(access.workspace.id)]);
  const preview = previewUrl(app.slug, assetsTabDeps.env());
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    header: await appHeaderFor(access, app.slug),
    canEdit: access.effectiveRole !== 'viewer' && !app.lockedReason,
    confirmPath: (url.searchParams.get('confirm') ?? '').slice(0, 220),
    assets: assets.map((a) => ({
      path: a.path,
      type: a.type,
      size: a.size,
      sizeText: formatBytes(a.size),
      updatedAt: a.updatedAt.toISOString(),
      url: `${preview}${a.path}`,
    })),
    used: formatBytes(used),
    quota: formatBytes(limits.quota),
    maxBytes: limits.maxBytes,
    maxText: formatBytes(limits.maxBytes),
  };
}

export type AssetsActionData =
  | { intent: 'upload-url'; uploadUrl: string; curl: string; assetPath: string; expiresAt: string; error?: undefined }
  | { intent: string; error: string; code?: string };

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const app = await appOf(access.workspace.id, String(params.appSlug ?? ''));
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const fail = (status: number, error: string, code?: string) => data<AssetsActionData>({ intent, error, ...(code ? { code } : {}) }, { status });
  if (app.lockedReason) return fail(423, 'This app was taken down by the server operator; its assets cannot change.', 'app_locked_by_admin');
  const name = String(form.get('path') ?? '').trim().replace(/^\//, '');
  const target = { id: app.id, slug: app.slug, workspaceId: app.workspaceId };

  if (intent === 'upload-url') {
    const size = Number(String(form.get('size') ?? '').trim());
    const contentType = String(form.get('type') ?? '').trim().slice(0, 100);
    try {
      await checkAssetUpload({ appId: app.id, name, size, contentType, limits: await limitsOf(access.workspace.id) });
    } catch (err) {
      if (isAssetsError(err)) return fail(err.status, err.message, err.code);
      throw err;
    }
    if (!(await assetsTabDeps.uploadAllowed(app.id))) {
      return fail(429, 'This app has used up its upload URLs for this hour (APP_ASSET_UPLOADS_PER_HOUR).', 'rate_limited');
    }
    const { token, expiresAt } = await createUploadToken(assetsTabDeps.tokens(), {
      appId: app.id,
      appSlug: app.slug,
      workspaceId: app.workspaceId,
      name,
      size,
      contentType,
      userId: access.user.id,
      actorKind: actorKindForSurface('web'),
      via: 'dashboard',
    });
    const uploadUrl = assetUploadUrl(dashboardOrigin(assetsTabDeps.env()), token);
    return data<AssetsActionData>({
      intent,
      uploadUrl,
      curl: curlUploadCommand(uploadUrl, name.slice(name.lastIndexOf('/') + 1)),
      assetPath: assetPath(name),
      expiresAt: expiresAt.toISOString(),
    });
  }

  if (intent === 'delete') {
    const removed = await deleteAsset({
      app: target,
      name,
      actor: { userId: access.user.id, kind: actorKindForSurface('web') },
      via: 'dashboard',
    });
    if (!removed) return fail(404, `This app has no asset at ${assetPath(name)}.`, 'asset_not_found');
    return redirect(`/workspaces/${access.workspace.slug}/apps/${app.slug}/assets`);
  }

  return fail(400, 'Unsupported action.');
}
