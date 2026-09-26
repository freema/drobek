/**
 * GET/POST /workspaces/:slug/modules — server half (NSO-347 + NSO-346).
 *
 * GET: a read-only overview of the platform modules this server runs, for
 * every member of the workspace (viewer+; a non-member → 404, anonymous →
 * /login): per module its name, version, source (`builtin` / `dir`), the
 * contract range it declares, availability, the modules it requires, the
 * slots it offers (and who contributes), its contributions to other modules'
 * slots, the limits it declares with the value in force for THIS workspace
 * (its plan, through the limits provider) and its own error codes. The facts
 * come from `ModuleRuntime.moduleFacts` — the same facts `skill_info(name)`
 * returns to agents. Never a path on disk, never a secret, never an app's
 * config.
 *
 * Each opt-in module also carries its state for the workspace (NSO-346,
 * ../workspace-modules-toggle.server.ts): enabled or not and what decides it
 * (plan / env / the super-admin's switch). Who flipped the switch (an
 * e-mail) is shown to workspace admins only.
 *
 * POST: the opt-in switch (`intent=workspace-module`) — super-admin only;
 * every other member gets 403 and nothing changes.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole, workspaceNav } from '@drobek/tenancy';
import { loadWorkspaceModuleToggles, workspaceModuleToggleAction } from '../workspace-modules-toggle.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const runtime = await moduleRuntime();
  const limits = await runtime.workspaceLimits(access.workspace.id);
  const modules = runtime.moduleFactsList().map((f) => ({
    ...f,
    useWhen: runtime.get(f.name)?.skill.useWhen ?? '',
    limits: f.limits.map((l) => ({ ...l, value: limits[l.name] ?? l.default })),
  }));
  const optIn = await loadWorkspaceModuleToggles(access);
  if (access.effectiveRole !== 'workspace-admin') {
    // Viewers and editors see the state, not which super-admin switched it.
    optIn.modules = optIn.modules.map((m) => ({ ...m, dashboard: { ...m.dashboard, enabled_by: null } }));
  }
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    /** The shared workspace chrome (breadcrumb, badges, tabs — NSO-342). */
    nav: workspaceNav(access),
    modules,
    /** NSO-346: each opt-in module's state for this workspace + whether this user may flip the switch. */
    optIn,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const form = await request.formData();
  const toggled = await workspaceModuleToggleAction(access, form);
  if (toggled) return toggled;
  return data({ error: 'Unsupported action.' }, { status: 400 });
}
