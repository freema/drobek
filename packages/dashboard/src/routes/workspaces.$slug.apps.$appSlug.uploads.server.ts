/**
 * GET/POST /workspaces/:slug/apps/:appSlug/uploads — server half of the
 * Uploads tab (M2-03): the files the app's end users uploaded, through the
 * files module's `files` authority (the owner's view: every file, whatever the
 * app's read rule).
 *
 * GET (viewer+): one page (50, newest first) with name, sniffed type, size,
 * uploader, time; usage against the app's quota. Raster images get an inline
 * preview served by `…/uploads/:fileId` (dashboard-proxied, `nosniff`).
 *
 * POST (editor+): `intent=delete` (after a confirm step) → the module's own
 * delete rule for the stored bytes (content another app still references
 * stays on disk) → audit `files.delete` (the id only).
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { AUDIT_ACTIONS } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { appHeaderFor } from '../app-page.server.js';
import { auditOwner, filesOf, ownerApp, ownerError } from '../owner-http.server.js';
import { PREVIEW_TYPES, formatBytes } from '../owner-view.js';

export const UPLOADS_PAGE = 50;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const url = new URL(request.url);
  const base = {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug: app.slug,
    /** NSO-342: the app header + tabs on every app sub-page. */
    header: await appHeaderFor(access, app.slug),
    canDelete: access.effectiveRole !== 'viewer',
    confirmId: (url.searchParams.get('confirm') ?? '').slice(0, 64),
  };
  const files = await filesOf(app);
  if (!files) return { ...base, enabled: false as const, files: [], used: '', quota: '', nextCursor: null, error: null };
  try {
    const page = await files.list({ limit: UPLOADS_PAGE, cursor: url.searchParams.get('cursor') || null });
    return {
      ...base,
      enabled: true as const,
      files: page.files.map((f) => ({ ...f, sizeText: formatBytes(f.size), previewable: PREVIEW_TYPES.has(f.type) })),
      used: formatBytes(page.used_bytes),
      quota: formatBytes(page.quota_bytes),
      nextCursor: page.next_cursor,
      error: null,
    };
  } catch (err) {
    return { ...base, enabled: true as const, files: [], used: '', quota: '', nextCursor: null, error: ownerError(err).message };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const app = await ownerApp(access, String(params.appSlug ?? ''));
  const form = await request.formData();
  if (String(form.get('intent') ?? '') !== 'delete') return data({ error: 'Unsupported action.' }, { status: 400 });
  const id = String(form.get('id') ?? '').trim();
  if (!/^[a-z0-9]{8,64}$/.test(id)) return data({ error: 'Missing file id.' }, { status: 400 });
  const files = await filesOf(app);
  if (!files) throw data({ message: 'Not found' }, { status: 404 });
  if (!(await files.remove(id))) throw data({ message: 'Not found' }, { status: 404 });
  await auditOwner(access, app, AUDIT_ACTIONS.filesDelete, { module: files.module, id });
  return redirect(`/workspaces/${access.workspace.slug}/apps/${app.slug}/uploads`);
}
