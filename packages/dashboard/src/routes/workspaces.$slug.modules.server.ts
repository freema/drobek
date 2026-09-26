/**
 * GET /workspaces/:slug/modules — server half (NSO-347). A read-only overview
 * of the platform modules this server runs, for every member of the
 * workspace (viewer+; a non-member → 404, anonymous → /login): per module
 * its name, version, source (`builtin` / `dir`), the contract range it
 * declares, availability, the modules it requires, the slots it offers (and
 * who contributes), its contributions to other modules' slots, the limits it
 * declares with the value in force for THIS workspace (its plan, through the
 * limits provider) and its own error codes.
 *
 * Everything comes from `ModuleRuntime.moduleFacts` — the same facts
 * `skill_info(name)` returns to agents. Never a path on disk, never a secret,
 * never an app's config.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole, workspaceNav } from '@drobek/tenancy';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const runtime = await moduleRuntime();
  const limits = await runtime.workspaceLimits(access.workspace.id);
  const modules = runtime.moduleFactsList().map((f) => ({
    ...f,
    useWhen: runtime.get(f.name)?.skill.useWhen ?? '',
    limits: f.limits.map((l) => ({ ...l, value: limits[l.name] ?? l.default })),
  }));
  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    /** The shared workspace chrome (breadcrumb, badges, tabs — NSO-342). */
    nav: workspaceNav(access),
    modules,
  };
}
