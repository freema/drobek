/**
 * NSO-366: the dashboard's side of publish approval — the notice data for a
 * workspace (`publishApprovalView`) and the "Request approval" POST
 * (`requestApprovalAction`, editor+), shared by the app pages and the
 * workspace's apps list.
 */
import { data, redirect } from 'react-router';
import {
  PUBLISH_APPROVAL_REQUEST_EVERY_MS,
  publishApprovalNotice,
  publishPermission,
  requestPublishApproval,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { roleAtLeast, type WorkspaceAccess } from '@drobek/tenancy';
import { safeRedirectTo } from './app-view.js';
import { REQUEST_PUBLISH_APPROVAL_INTENT, type PublishApprovalView } from './publish-approval-notice.js';

/** null when the workspace may publish (or the server runs PUBLISH_APPROVAL=open). */
export async function publishApprovalView(
  workspaceId: string,
  userId: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {}
): Promise<PublishApprovalView | null> {
  const p = await publishPermission(workspaceId, { actorUserId: userId, ...(opts.env ? { env: opts.env } : {}) });
  if (p.allowed) return null;
  const now = opts.now ?? Date.now();
  return {
    contact: p.contact,
    notice: publishApprovalNotice(p.contact),
    requestedAt: p.requestedAt ? p.requestedAt.toISOString() : null,
    requestPending: p.requestedAt !== null && now - p.requestedAt.getTime() < PUBLISH_APPROVAL_REQUEST_EVERY_MS,
  };
}

/**
 * The "Request approval" POST: null for any other intent. A viewer → 403;
 * otherwise the request is recorded and e-mailed (deduped) and the page is
 * reloaded at `redirectTo` (within `base`), where the notice says it was sent.
 */
export async function requestApprovalAction(
  access: WorkspaceAccess,
  form: FormData,
  opts: { base: string; fallback: string; appName?: string | null }
) {
  if (String(form.get('intent') ?? '') !== REQUEST_PUBLISH_APPROVAL_INTENT) return null;
  if (!roleAtLeast(access.effectiveRole, 'editor')) {
    return data({ error: 'Only an editor or a workspace admin can request publish approval.', intent: REQUEST_PUBLISH_APPROVAL_INTENT }, { status: 403 });
  }
  await requestPublishApproval({
    workspaceId: access.workspace.id,
    actor: { userId: access.user.id, kind: actorKindForSurface('web') },
    appName: opts.appName ?? null,
  });
  return redirect(safeRedirectTo(form.get('redirectTo') ?? opts.fallback, opts.base));
}
