/**
 * GET/POST /workspaces/:slug/delete — server half: a workspace admin deletes
 * a team workspace. Workspace-admin (or super-admin) only, via the role
 * middleware: anyone else gets 403, a non-member 404.
 *
 * GET: what the deletion takes (apps, published ones, members, pending
 * invites, upstreams). A personal workspace gets no form: it goes only with
 * its owner's account (/me/delete).
 *
 * POST: the typed slug must match; then @drobek/tenancy deleteWorkspace
 * soft-deletes and purges every app (with the modules' onAppDelete and the
 * end-user session clean-up), deletes the workspace with its memberships,
 * upstreams and invites, and audits `workspace.delete` → /workspaces?deleted=<slug>.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { actorKindForSurface } from '@drobek/audit';
import {
  DeletionError,
  deleteWorkspace,
  requireWorkspaceRole,
  workspaceDeletionSummary,
  workspaceNav,
} from '@drobek/tenancy';
import { appDeletionHooks } from '../deletion.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'workspace-admin');
  const personal = access.workspace.kind === 'personal';
  return {
    nav: await workspaceNav(access),
    workspace: { slug: access.workspace.slug, name: access.workspace.name, kind: access.workspace.kind },
    personal,
    summary: personal ? null : await workspaceDeletionSummary(access.workspace.id),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'workspace-admin');
  const form = await request.formData();
  const { workspace } = access;
  if (String(form.get('confirm') ?? '').trim() !== workspace.slug) {
    return data({ error: `Type the workspace’s slug, ${workspace.slug}, to confirm the deletion. Nothing was deleted.` }, { status: 400 });
  }
  try {
    await deleteWorkspace({
      workspace,
      actor: { userId: access.user.id, kind: actorKindForSurface('web'), role: access.effectiveRole },
      hooks: await appDeletionHooks(),
    });
  } catch (err) {
    if (err instanceof DeletionError) {
      return data({ error: err.message }, { status: err.code === 'forbidden' ? 403 : 400 });
    }
    throw err;
  }
  return redirect(`/workspaces?deleted=${encodeURIComponent(workspace.slug)}`);
}
