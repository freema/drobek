/**
 * /workspaces/:slug/invite — client half (U4, PHY-54): shows the freshly
 * created invite link (always) and whether the email went out. Reached by
 * submitting the invite form on the workspace page.
 */
import { useActionData, useLoaderData } from 'react-router';
import { WorkspacePage } from '../layout.js';
import type { action, loader } from './workspaces.$slug.invite.server.js';

export function meta() {
  return [{ title: 'Invite — drobek' }];
}

const styles = {
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  linkBox: {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    background: '#fafafa',
    wordBreak: 'break-all',
    margin: '1rem 0',
  },
  ok: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
} as const;

export default function InviteCreatedRoute() {
  const { nav } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();

  return (
    <WorkspacePage workspace={nav} section="members" trail={[{ label: 'Invite' }]}>
      <h2 style={styles.h2}>Invite</h2>

      {!result ? (
        <p style={styles.hint}>
          No invite was created. Use the invite form on the workspace page.
        </p>
      ) : 'error' in result ? (
        <div style={styles.error} role="alert">
          {result.error}
        </div>
      ) : (
        <>
          <p style={styles.hint}>
            Invite created for role <strong>{result.role}</strong>. It expires
            in 7 days and can be used once.
          </p>
          <code style={styles.linkBox} data-testid="invite-link">
            {result.inviteUrl}
          </code>
          {result.email ? (
            result.emailSent ? (
              <div style={styles.ok}>
                Invitation email sent to <strong>{result.email}</strong>.
              </div>
            ) : (
              <div style={styles.error} role="alert">
                The invitation email to {result.email} could not be sent —
                share the link above instead.
              </div>
            )
          ) : (
            <p style={styles.hint}>Share this link with your teammate.</p>
          )}
        </>
      )}
    </WorkspacePage>
  );
}
