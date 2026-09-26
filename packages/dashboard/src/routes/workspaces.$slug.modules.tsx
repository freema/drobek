/**
 * /workspaces/:slug/modules — client half (NSO-347): the platform modules of
 * this server, read-only, for every member of the workspace. One card per
 * module: its facts (version, source, contract, availability, requires), the
 * slots it offers and who contributes, its own contributions, its limits for
 * this workspace and its error codes. Values arrive pre-shaped and
 * secret-free from the .server.ts.
 *
 * The per-workspace enable toggle of an opt-in module (a super-admin
 * control) mounts through `<WorkspaceModules availabilityControls={…}>`.
 */
import { useLoaderData } from 'react-router';
import { WorkspacePage } from '@drobek/tenancy/layout';
import type { loader } from './workspaces.$slug.modules.server.js';
import { WorkspaceModules } from '../module-ui/workspace-modules.js';
import { ui } from '../module-ui/styles.js';

type Data = Awaited<ReturnType<typeof loader>>;

export function meta({ data }: { data?: Data }) {
  return [{ title: `Modules — ${data?.workspace.name ?? 'Workspace'} — drobek` }];
}

const styles = {
  intro: { color: '#3f3f46', margin: '1.25rem 0 0', fontSize: '0.95rem', maxWidth: '46rem' },
} as const;

export default function WorkspaceModulesRoute() {
  const d = useLoaderData<typeof loader>();
  return (
    <WorkspacePage workspace={d.nav} section="modules">
      <p style={styles.intro} data-testid="modules-intro">
        The platform modules this server runs — the backends apps use (login, stored data, forms…). The operator installs
        them; each app configures the ones it uses on its Modules tab. Agents read the same facts with{' '}
        <code style={ui.mono}>skill_info</code>.
      </p>
      {/* The opt-in enable toggle mounts here: availabilityControls={(m) => …}. */}
      <WorkspaceModules modules={d.modules} />
    </WorkspacePage>
  );
}
