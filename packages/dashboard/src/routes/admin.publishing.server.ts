/**
 * GET/POST /admin/publishing — server half (NSO-366): the super-admin's
 * publish approvals. SUPER-ADMIN ONLY: no session → /login; a signed-in user
 * who is not in SUPERADMIN_EMAIL → 403 (loader AND action).
 *
 * Lists workspaces with their approval state (`?state=requested` — the
 * waiting requests, the default; `not_approved`, `approved`, `all`):
 * members' admins, apps / published apps, who asked and when, who approved.
 * Actions: `approve` / `revoke` (workspace) — @drobek/apps
 * `setPublishApproval`, audited `workspace.publish_approve` /
 * `workspace.publish_revoke`. The MCP tool set_publish_approval is the same
 * function. With PUBLISH_APPROVAL=open the page still works; the state
 * matters once the operator switches to `approval`.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  AppsError,
  PUBLISH_APPROVAL_FILTERS,
  listPublishApprovals,
  operatorContact,
  publishApprovalMode,
  setPublishApproval,
  type PublishApprovalFilter,
} from '@drobek/apps';
import { actorKindForSurface } from '@drobek/audit';
import { isSuperAdmin, requireSessionUser, type SessionUser } from '@drobek/auth';
import { createConsoleLogger } from '@drobek/core';

const log = createConsoleLogger('publish-approval');

async function requireSuperAdmin(request: Request): Promise<SessionUser> {
  const user = await requireSessionUser(request);
  if (!isSuperAdmin(user.email)) {
    throw data({ message: 'Only the operator of this server (a super-admin) can approve workspaces for publishing.' }, { status: 403 });
  }
  return user;
}

function filterOf(raw: string | null): PublishApprovalFilter {
  return (PUBLISH_APPROVAL_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as PublishApprovalFilter) : 'requested';
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireSuperAdmin(request);
  const state = filterOf(new URL(request.url).searchParams.get('state'));
  const entries = await listPublishApprovals({ filter: state });
  return data(
    {
      state,
      states: PUBLISH_APPROVAL_FILTERS,
      mode: publishApprovalMode(),
      contact: operatorContact(),
      workspaces: entries.map((e) => ({
        id: e.id,
        slug: e.slug,
        name: e.name,
        kind: e.kind,
        createdAt: e.createdAt.toISOString(),
        approvedAt: e.approvedAt?.toISOString() ?? null,
        approvedBy: e.approvedByEmail,
        requestedAt: e.requestedAt?.toISOString() ?? null,
        requestedBy: e.requestedByEmail,
        apps: e.apps,
        publishedApps: e.publishedApps,
        admins: e.admins,
        superAdminMember: e.superAdminMember,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSuperAdmin(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  if (intent !== 'approve' && intent !== 'revoke') return data<ActionResult>({ ok: false, error: 'Unknown action.' }, { status: 400 });
  const approved = intent === 'approve';
  try {
    const out = await setPublishApproval({
      workspaceId: String(form.get('workspaceId') ?? ''),
      approved,
      actor: { userId: user.id, kind: actorKindForSurface('web') },
    });
    if (out.changed) {
      log.warn(approved ? 'workspace approved for publishing' : 'publish approval revoked', {
        event: approved ? 'admin_publish_approve' : 'admin_publish_revoke',
        workspace: out.slug,
      });
    }
    const message = approved
      ? out.changed
        ? `${out.slug} may publish now.`
        : `${out.slug} was already approved.`
      : out.changed
        ? `${out.slug} can no longer publish. Its live apps keep serving.`
        : `${out.slug} was not approved.`;
    return data<ActionResult>({ ok: true, message });
  } catch (err) {
    if (err instanceof AppsError && err.code === 'not_found') return data<ActionResult>({ ok: false, error: 'No such workspace.' }, { status: 404 });
    throw err;
  }
}
