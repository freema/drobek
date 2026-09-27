/**
 * GET/POST /admin/publishing — server half (NSO-366): the super-admin's
 * switch for who may publish. SUPER-ADMIN ONLY: no session → /login; a
 * signed-in user who is not in SUPERADMIN_EMAIL → 403 (loader AND action).
 *
 * Lists workspaces with their publishing state (`?state=` requested |
 * default | allowed | blocked | all — the waiting requests by default in
 * `approval` mode, every workspace in `open` mode; `?workspace=<slug>` shows
 * one): admins, apps / published apps, who asked, allowed or blocked and
 * when, and the live apps — each with the takedown form of the moderation
 * queue (it posts to /admin/abuse). Actions: `approve` (→ allowed),
 * `revoke` (allowed → default), `block` (→ blocked), `unblock` (blocked →
 * default) — @drobek/apps `setWorkspacePublishing`, audited, blocking and
 * unblocking e-mail the workspace's editors and admins. The MCP tool
 * set_workspace_publishing is the same function.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  LOCK_REASONS,
  PUBLISHING_FILTERS,
  listWorkspacePublishing,
  operatorContact,
  publishApprovalMode,
  publishedUrl,
  reasonLabel,
  setWorkspacePublishing,
  type PublishingFilter,
  type WorkspacePublishing,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { isSuperAdmin, requireSessionUser, type SessionUser } from '@drobek/auth';
import { createConsoleLogger } from '@drobek/core';

const log = createConsoleLogger('publish-approval');

async function requireSuperAdmin(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isSuperAdmin(user.email)) {
    throw data({ message: 'Only the operator of this server (a super-admin) can decide who may publish.' }, { status: 403 });
  }
  return user;
}

function filterOf(raw: string | null, fallback: PublishingFilter): PublishingFilter {
  return (PUBLISHING_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as PublishingFilter) : fallback;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireSuperAdmin(request);
  const params = new URL(request.url).searchParams;
  const mode = publishApprovalMode();
  const fallback: PublishingFilter = mode === 'approval' ? 'requested' : 'all';
  const rawWorkspace = (params.get('workspace') ?? '').trim().toLowerCase();
  const workspace = rawWorkspace && /^[a-z0-9-]{1,64}$/.test(rawWorkspace) ? rawWorkspace : null;
  const state = workspace ? filterOf(params.get('state'), 'all') : filterOf(params.get('state'), fallback);
  const entries = await listWorkspacePublishing({ filter: state, workspace });
  return data(
    {
      state,
      defaultState: fallback,
      states: PUBLISHING_FILTERS,
      workspace,
      mode,
      contact: operatorContact(),
      reasons: LOCK_REASONS.map((value) => ({ value, label: reasonLabel(value) })),
      workspaces: entries.map((e) => ({
        id: e.id,
        slug: e.slug,
        name: e.name,
        kind: e.kind,
        publishing: e.publishing,
        createdAt: e.createdAt.toISOString(),
        approvedAt: e.approvedAt?.toISOString() ?? null,
        approvedBy: e.approvedByEmail,
        blockedAt: e.blockedAt?.toISOString() ?? null,
        blockedBy: e.blockedByEmail,
        requestedAt: e.requestedAt?.toISOString() ?? null,
        requestedBy: e.requestedByEmail,
        apps: e.apps,
        publishedApps: e.publishedApps,
        liveApps: e.liveApps.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name ?? a.slug,
          url: publishedUrl(a.slug),
        })),
        admins: e.admins,
        superAdminMember: e.superAdminMember,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const INTENT_STATE: Record<string, WorkspacePublishing> = {
  approve: 'allowed',
  revoke: 'default',
  block: 'blocked',
  unblock: 'default',
};

function messageFor(intent: string, slug: string, changed: boolean, mode: 'open' | 'approval'): string {
  if (intent === 'approve') return changed ? `${slug} may publish now.` : `${slug} was already allowed.`;
  if (intent === 'block') {
    return changed
      ? `${slug} can no longer publish. Its live apps keep serving; its editors and admins were e-mailed.`
      : `${slug} was already blocked.`;
  }
  if (!changed) return `${slug} is already on the server default.`;
  if (intent === 'unblock') {
    return mode === 'open'
      ? `${slug} is unblocked and may publish again; its editors and admins were e-mailed.`
      : `${slug} is unblocked; it publishes once approved. Its editors and admins were e-mailed.`;
  }
  return mode === 'open'
    ? `${slug} follows the server default again (open: it may publish).`
    : `${slug} can no longer publish until it is approved again. Its live apps keep serving.`;
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSuperAdmin(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const to = Object.hasOwn(INTENT_STATE, intent) ? INTENT_STATE[intent] : undefined;
  if (!to) return data<ActionResult>({ ok: false, error: 'Unknown action.' }, { status: 400 });
  try {
    const out = await setWorkspacePublishing({
      workspaceId: String(form.get('workspaceId') ?? ''),
      publishing: to,
      actor: { userId: user.id, kind: actorKindForSurface('web') },
      log,
    });
    if (out.changed) {
      log.warn('workspace publishing changed by a super-admin', {
        event: `admin_publish_${intent}`,
        workspace: out.slug,
        from: out.previous,
        to: out.publishing,
      });
    }
    return data<ActionResult>({ ok: true, message: messageFor(intent, out.slug, out.changed, publishApprovalMode()) });
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_found') return data<ActionResult>({ ok: false, error: 'No such workspace.' }, { status: 404 });
    throw err;
  }
}
