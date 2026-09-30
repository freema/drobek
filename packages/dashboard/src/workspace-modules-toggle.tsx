/**
 * One opt-in module's state for a workspace and — for a
 * super-admin — its Enable / Disable switch. The workspace Modules page
 * mounts it next to the module's availability through
 * `<WorkspaceModules availabilityControls={…}>`; the server half is
 * ./workspace-modules-toggle.server.ts. Everyone else sees the state
 * read-only. A module that needs another opt-in module still off here says
 * which (its Enable button stays disabled until then); one that other
 * enabled modules depend on names them.
 */
import { Form } from 'react-router';
import type { WorkspaceModuleState } from '@drobek/modules';
import { ui } from './module-ui/styles.js';

const SOURCE_TEXT: Record<string, string> = {
  plan: 'set by the workspace plan (limits provider)',
  env: 'enabled on every workspace by the server configuration',
  dashboard: 'enabled by a super-admin',
};

function names(list: string[]): string {
  return list.map((n) => `"${n}"`).join(', ');
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
}

export function WorkspaceModuleOptIn({
  module: m,
  canToggle,
  busy = false,
}: {
  module: WorkspaceModuleState;
  canToggle: boolean;
  busy?: boolean;
}) {
  const blocked = m.missing_requires.length > 0;
  return (
    <div
      style={{ marginTop: '0.35rem' }}
      data-testid="workspace-module-row"
      data-module={m.name}
      data-enabled={m.enabled ? '1' : '0'}
      data-source={m.source ?? ''}
    >
      <div style={ui.row}>
        {m.enabled ? (
          <span style={ui.okBadge} data-testid="workspace-module-state">
            enabled for this workspace
          </span>
        ) : (
          <span style={ui.badge} data-testid="workspace-module-state">
            not enabled for this workspace
          </span>
        )}
        {canToggle ? (
          <Form method="post">
            <input type="hidden" name="intent" value="workspace-module" />
            <input type="hidden" name="module" value={m.name} />
            <input type="hidden" name="enabled" value={m.dashboard.enabled ? '0' : '1'} />
            <button
              type="submit"
              style={m.dashboard.enabled ? ui.secondaryButton : ui.button}
              disabled={busy || (blocked && !m.dashboard.enabled)}
              data-testid="workspace-module-toggle"
            >
              {m.dashboard.enabled ? 'Disable' : 'Enable'}
            </button>
          </Form>
        ) : null}
      </div>
      <p style={ui.small} data-testid="workspace-module-source">
        {m.source ? SOURCE_TEXT[m.source] : 'Nothing enables it for this workspace.'}
        {m.dashboard.enabled
          ? ` Switched on${m.dashboard.enabled_by ? ` by ${m.dashboard.enabled_by}` : ''} at ${when(m.dashboard.enabled_at)}${
              m.source === 'plan' && !m.enabled && !blocked ?' — the plan disables it anyway.' : '.'
            }`
          : ''}
      </p>
      {blocked ? (
        <p style={ui.small} data-testid="workspace-module-missing-requires">
          It needs {names(m.missing_requires)}, which {m.missing_requires.length > 1 ? 'are' : 'is'} not enabled for this workspace
          {m.source ? ', so it is off here' : ''}.
          {canToggle ? ` Enable ${m.missing_requires.map((n) => `"${n}"`).join(', then ')} first.` : ''}
        </p>
      ) : null}
      {m.required_by.length > 0 ? (
        <p style={ui.small} data-testid="workspace-module-required-by">
          {names(m.required_by)} {m.required_by.length > 1 ? 'depend' : 'depends'} on it
          {canToggle ? ': disabling it turns them off for this workspace too.' : '.'}
        </p>
      ) : null}
    </div>
  );
}
