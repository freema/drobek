/**
 * /workspaces/:slug/delete — client half: a workspace admin deletes a team
 * workspace after typing its slug. Lists what goes; a personal workspace
 * points to the account deletion instead. Data arrives shaped from
 * ./workspaces.$slug.delete.server.ts.
 */
import type { CSSProperties } from 'react';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { WorkspacePage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './workspaces.$slug.delete.server.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Delete ${data?.workspace.name ?? 'workspace'} — drobek` }];
}

const styles = {
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  danger: {
    border: '1px solid #fecaca',
    background: '#fef2f2',
    borderRadius: '10px',
    padding: '1rem 1.1rem',
    maxWidth: '46rem',
    color: '#7f1d1d',
  },
  text: { margin: 0, fontSize: '0.95rem' },
  list: { margin: '0.5rem 0 1rem', paddingLeft: '1.2rem', fontSize: '0.95rem' },
  label: { display: 'block', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.3rem' },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.9em' },
  hint: { color: '#555', fontSize: '0.95rem', maxWidth: '46rem' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
    maxWidth: '46rem',
  },
} satisfies Record<string, CSSProperties>;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function DeleteWorkspaceRoute() {
  const { nav, workspace, personal, summary } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';

  return (
    <WorkspacePage workspace={nav} section="members" trail={[{ label: 'Delete workspace' }]}>
      <h2 style={styles.h2}>Delete workspace</h2>
      {personal || !summary ? (
        <p style={styles.hint} data-testid="delete-workspace-personal">
          A personal workspace is deleted only together with your account. To delete single apps, open them and use
          Settings → Delete app; to delete everything, go to{' '}
          <Link to="/me/delete" style={{ fontWeight: 600, color: '#1a1a1a' }}>
            Delete your account
          </Link>
          .
        </p>
      ) : (
        <div style={styles.danger} data-testid="delete-workspace-form">
          <p style={styles.text}>
            You are deleting <strong>{workspace.name}</strong> (slug <code style={styles.mono}>{workspace.slug}</code>)
            for good. It cannot be restored. Deleting it:
          </p>
          <ul style={styles.list} data-testid="delete-workspace-summary">
            <li>
              deletes {plural(summary.apps, 'app', 'apps')}
              {summary.published > 0 ? ` (${summary.published} published)` : ''} with their versions, data, form
              submissions, end users, uploads and custom domains — their addresses stop answering at once;
            </li>
            <li>
              ends the access of {plural(summary.members, 'member', 'members')}, in the dashboard and through their
              agents;
            </li>
            <li>
              stops {plural(summary.pendingInvites, 'pending invite link', 'pending invite links')} and removes{' '}
              {plural(summary.upstreams, 'upstream', 'upstreams')} with their keys.
            </li>
          </ul>
          <p style={{ ...styles.text, marginBottom: '1rem' }}>
            The activity entries stay with the server operator; your own Activity (in your personal workspace) records
            the deletion.
          </p>
          {result && 'error' in result ? (
            <p style={styles.error} role="alert" data-testid="delete-workspace-error">
              {result.error}
            </p>
          ) : null}
          <Form method="post">
            <label htmlFor="workspace-delete-confirm" style={styles.label}>
              To confirm, type the workspace&apos;s slug <code style={styles.mono}>{workspace.slug}</code>
            </label>
            <div style={styles.row}>
              <input
                id="workspace-delete-confirm"
                type="text"
                name="confirm"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{ ...controls.input, flex: '1 1 16rem', minWidth: 'min(16rem, 100%)' }}
                data-testid="delete-workspace-confirm"
              />
              <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="delete-workspace-button">
                Delete this workspace
              </button>
            </div>
          </Form>
        </div>
      )}
    </WorkspacePage>
  );
}
