/**
 * /workspaces/:slug/modules — client half (NSO-347 + NSO-346): the platform
 * modules of this server, read-only, for every member of the workspace. One
 * card per module: its facts (version, source, contract, availability,
 * requires), the slots it offers and who contributes, its own contributions,
 * its limits for this workspace and its error codes. Values arrive
 * pre-shaped and secret-free from the .server.ts.
 *
 * An opt-in module's state for the workspace — and, for a super-admin, its
 * Enable / Disable switch — mounts through
 * `<WorkspaceModules availabilityControls={…}>` (../workspace-modules-toggle.tsx).
 */
import { useActionData, useLoaderData, useNavigation } from 'react-router';
import { WorkspacePage } from '@drobek/tenancy/layout';
import type { action, loader } from './workspaces.$slug.modules.server.js';
import { WorkspaceModules } from '../module-ui/workspace-modules.js';
import { ui } from '../module-ui/styles.js';
import { WorkspaceModuleOptIn } from '../workspace-modules-toggle.js';

type Data = Awaited<ReturnType<typeof loader>>;

export function meta({ data }: { data?: Data }) {
  return [{ title: `Modules — ${data?.workspace.name ?? 'Workspace'} — drobek` }];
}

const styles = {
  intro: { color: '#3f3f46', margin: '1.25rem 0 0', fontSize: '0.95rem', maxWidth: '46rem' },
} as const;

export default function WorkspaceModulesRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const error = actionData && 'error' in actionData ? actionData.error : null;
  const optIn = new Map(d.optIn.modules.map((m) => [m.name, m]));
  return (
    <WorkspacePage workspace={d.nav} section="modules">
      <p style={styles.intro} data-testid="modules-intro">
        The platform modules this server runs — the backends apps use (login, stored data, forms…). The operator installs
        them; each app configures the ones it uses on its Modules tab. Agents read the same facts with{' '}
        <code style={ui.mono}>skill_info</code>.
        {d.optIn.modules.length > 0
          ? d.optIn.canToggle
            ? ' An opt-in module works only in the workspaces it is enabled for; as a super-admin you can enable or disable it here (a value the workspace plan sets wins over this switch).'
            : ' An opt-in module works only in the workspaces it is enabled for; a super-admin enables it per workspace (or the workspace plan does).'
          : null}
      </p>
      {error ? (
        <div style={ui.error} role="alert" data-testid="workspace-module-error">
          {error}
        </div>
      ) : null}
      <WorkspaceModules
        modules={d.modules}
        availabilityControls={(m) => {
          const state = optIn.get(m.name);
          return state ? <WorkspaceModuleOptIn module={state} canToggle={d.optIn.canToggle} busy={busy} /> : null;
        }}
      />
    </WorkspacePage>
  );
}
