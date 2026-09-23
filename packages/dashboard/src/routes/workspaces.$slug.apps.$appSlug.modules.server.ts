/**
 * GET /workspaces/:slug/apps/:appSlug/modules — server half (M2-02,
 * NSO-291): the app's Modules tab — every platform module active on the
 * server with whether this app configured it, what waits for confirmation and
 * which required secrets are missing. viewer+ (unknown workspace / non-member
 * → 404 by requireWorkspaceRole; an app of another workspace → 404). Secret
 * VALUES never reach this loader: the runtime reports `hasSecret` only.
 */
import { data, type LoaderFunctionArgs } from 'react-router';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { loadAppForView } from '../apps.server.js';
import { loadPendingBanner } from '../pending-banner.server.js';
import { canPublish } from '../view.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const app = await loadAppForView(access.workspace.id, String(params.appSlug ?? ''));
  if (!app) throw data({ message: 'Not found' }, { status: 404 });

  const runtime = await moduleRuntime();
  const states = await runtime.appModules(app.id);
  const modules = runtime.modules.map((m) => {
    const s = states[m.name];
    const secrets = s?.secrets ?? [];
    const requiredMissing = (m.secrets ?? []).filter((d) => d.required && !secrets.find((x) => x.name === d.name)?.hasSecret).map((d) => d.name);
    return {
      name: m.name,
      version: m.version,
      useWhen: m.skill.useWhen,
      configured: Boolean(s?.configured),
      pending: s?.pending_confirmation ?? [],
      secretsSet: secrets.filter((x) => x.hasSecret).length,
      secretsDeclared: secrets.length,
      secretsMissing: requiredMissing,
    };
  });

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    app: { slug: app.slug },
    modules,
    banner: await loadPendingBanner(app, access.workspace.slug, app.slug),
    canEdit: canPublish(access.effectiveRole),
  };
}
