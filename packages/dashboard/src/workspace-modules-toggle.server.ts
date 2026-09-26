/**
 * NSO-346: the opt-in modules of one workspace — the server half of the
 * Workspace → Modules switch (self-contained: a route mounts
 * `loadWorkspaceModuleToggles` in its loader and `workspaceModuleToggleAction`
 * in its action).
 *
 * Every workspace admin sees the opt-in modules with their state (enabled,
 * by whom / when, and what decides it: `dashboard` — the super-admin's
 * switch, `plan` — the limits provider's `MODULE_ENABLED_<NAME>`, `env` —
 * the operator's `MODULE_ENABLED_<NAME>=1`). Only a super-admin may flip the
 * switch (moderation, dashboard-only: there is no MCP tool); everyone else
 * gets 403. The POST is a React Router action, so the framework's origin
 * check runs before it. Audit: `module.workspace_enable` /
 * `module.workspace_disable` (meta: module), written by the runtime.
 */
import { data } from 'react-router';
import { isModuleError, moduleRuntime, type WorkspaceModuleState } from '@drobek/modules';
import type { WorkspaceAccess } from '@drobek/tenancy';

/** The form intent the switch posts. */
const WORKSPACE_MODULE_INTENT = 'workspace-module';

export interface WorkspaceModuleToggles {
  modules: WorkspaceModuleState[];
  /** Only a super-admin flips the switch; others see the state read-only. */
  canToggle: boolean;
}

export async function loadWorkspaceModuleToggles(access: WorkspaceAccess): Promise<WorkspaceModuleToggles> {
  const runtime = await moduleRuntime();
  return { modules: await runtime.workspaceModules(access.workspace.id), canToggle: access.superAdmin };
}

/**
 * Handle the switch's POST (`intent=workspace-module`, `module`, `enabled=1|0`).
 * Returns null for any other intent (the route handles those), otherwise the
 * action data: `{ ok, module, enabled, changed }` or `{ error }` + a status.
 */
export async function workspaceModuleToggleAction(access: WorkspaceAccess, form: FormData) {
  if (String(form.get('intent') ?? '') !== WORKSPACE_MODULE_INTENT) return null;
  if (!access.superAdmin) {
    return data({ error: 'Only a super-admin can enable or disable an opt-in module for a workspace.' }, { status: 403 });
  }
  const module = String(form.get('module') ?? '');
  const enabled = String(form.get('enabled') ?? '') === '1';
  const runtime = await moduleRuntime();
  try {
    const { changed } = await runtime.setWorkspaceModule({
      workspaceId: access.workspace.id,
      module,
      enabled,
      actorUserId: access.user.id,
    });
    return data({ ok: true as const, module, enabled, changed });
  } catch (err) {
    if (isModuleError(err)) return data({ error: err.message }, { status: err.status });
    throw err;
  }
}
