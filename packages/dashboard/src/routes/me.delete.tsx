/**
 * /me/delete — client half: delete your account. Shows what goes and what
 * stays, the team workspaces that still need you (no deletion then), and the
 * two steps: e-mail me a code → type it and delete. Data arrives shaped from
 * ./me.delete.server.ts.
 */
import type { CSSProperties } from 'react';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { DashboardPage, controls, workspaceHref } from '@drobek/tenancy/layout';
import type { DeleteAccountActionData, loader } from './me.delete.server.js';

export function meta() {
  return [{ title: 'Delete your account — drobek' }];
}

const styles = {
  h1: { fontSize: '1.75rem', margin: '0 0 0.75rem' },
  h2: { fontSize: '1.05rem', margin: '1.25rem 0 0.35rem' },
  text: { margin: '0 0 0.5rem', fontSize: '0.95rem', maxWidth: '46rem' },
  list: { margin: '0.25rem 0 0.75rem', paddingLeft: '1.2rem', fontSize: '0.95rem', maxWidth: '46rem' },
  muted: { color: '#71717a', fontSize: '0.85rem' },
  link: { fontWeight: 600, color: '#1a1a1a' },
  danger: {
    border: '1px solid #fecaca',
    background: '#fef2f2',
    borderRadius: '10px',
    padding: '1rem 1.1rem',
    maxWidth: '46rem',
    color: '#7f1d1d',
    marginTop: '1.25rem',
  },
  blocked: {
    border: '1px solid #fde68a',
    background: '#fffbeb',
    borderRadius: '10px',
    padding: '1rem 1.1rem',
    maxWidth: '46rem',
    color: '#78350f',
    marginTop: '1.25rem',
  },
  label: { display: 'block', fontWeight: 600, fontSize: '0.9rem', margin: '0.5rem 0 0.3rem' },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' },
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
  ok: { margin: '0 0 0.5rem', fontSize: '0.95rem' },
} satisfies Record<string, CSSProperties>;

function apps(n: number): string {
  return n === 0 ? 'no apps' : `${n} app${n === 1 ? '' : 's'}`;
}

export default function DeleteAccountRoute() {
  const { email, masked, plan } = useLoaderData<typeof loader>();
  const result = useActionData() as DeleteAccountActionData | undefined;
  const busy = useNavigation().state !== 'idle';
  const blocked = plan.blockers.length > 0;
  const codeStage = result?.stage === 'code';

  return (
    <DashboardPage crumbs={[{ label: 'Account', to: '/me' }, { label: 'Delete account' }]}>
      <h1 style={styles.h1}>Delete your account</h1>
      <p style={styles.text}>
        This deletes the account <strong>{email}</strong> for good. It cannot be restored; signing in again with the
        same address starts a new, empty account.
      </p>

      <h2 style={styles.h2}>Deleted with your account</h2>
      <ul style={styles.list} data-testid="account-delete-deletes">
        {plan.deletes.map((w) => (
          <li key={w.slug} data-slug={w.slug}>
            {w.kind === 'personal' ? 'Your personal workspace' : 'The team workspace'} <strong>{w.name}</strong>{' '}
            <span style={styles.muted}>/{w.slug}</span> with {apps(w.apps)} — their versions, data, uploads and
            addresses{w.kind === 'team' ? ' (you are its only member)' : ''}
          </li>
        ))}
        <li>your sign-in sessions, your API keys and every connected agent (OAuth connection) — they stop working at once</li>
      </ul>

      {plan.leaves.length > 0 ? (
        <>
          <h2 style={styles.h2}>Workspaces you leave</h2>
          <ul style={styles.list} data-testid="account-delete-leaves">
            {plan.leaves.map((w) => (
              <li key={w.slug} data-slug={w.slug}>
                <strong>{w.name}</strong> <span style={styles.muted}>/{w.slug} · {w.role}</span>
              </li>
            ))}
          </ul>
          <p style={styles.text}>
            Their other members keep them. The versions, upstreams and activity entries you made there stay, without
            your name.
          </p>
        </>
      ) : null}

      {blocked ? (
        <div style={styles.blocked} role="alert" data-testid="account-delete-blocked">
          <p style={styles.ok}>
            <strong>Your account cannot be deleted yet.</strong> You are the only workspace-admin of these team
            workspaces, and other members still use them:
          </p>
          <ul style={styles.list}>
            {plan.blockers.map((w) => (
              <li key={w.slug} data-slug={w.slug}>
                <Link to={workspaceHref(w.slug)} style={styles.link}>
                  {w.name}
                </Link>{' '}
                <span style={styles.muted}>
                  /{w.slug} · {w.members} members
                </span>{' '}
                — make another member a workspace-admin on its Members tab, or{' '}
                <Link to={`/workspaces/${w.slug}/delete`} style={styles.link}>
                  delete the workspace
                </Link>
                .
              </li>
            ))}
          </ul>
          <p style={{ ...styles.ok, margin: 0 }}>Then come back here.</p>
        </div>
      ) : (
        <div style={styles.danger} data-testid="account-delete-form">
          {result?.error ? (
            <p style={styles.error} role="alert" data-testid="account-delete-error">
              {result.error}
            </p>
          ) : null}
          {codeStage ? (
            <>
              <p style={styles.ok} role="status" data-testid="account-delete-code-sent">
                {result?.stage === 'code' && result.sent
                  ? `We e-mailed a 6-digit code to ${masked}. It works once, for 10 minutes.`
                  : `A code was e-mailed to ${masked} a moment ago; use the newest one. It works once, for 10 minutes.`}
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <label htmlFor="account-delete-code" style={styles.label}>
                  Code from the e-mail
                </label>
                <div style={styles.row}>
                  <input
                    id="account-delete-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    style={{ ...controls.input, width: '9rem', letterSpacing: '0.2em' }}
                    data-testid="account-delete-code"
                  />
                  <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="account-delete-button">
                    Delete my account
                  </button>
                </div>
              </Form>
              <Form method="post" style={{ marginTop: '0.75rem' }}>
                <input type="hidden" name="intent" value="send-code" />
                <button type="submit" style={controls.secondaryButton} disabled={busy} data-testid="account-delete-resend">
                  Send a new code
                </button>
              </Form>
            </>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="send-code" />
              <p style={styles.ok}>
                To confirm it is you, we e-mail a code to {masked}. You type it on the next step, and the account is
                deleted at once.
              </p>
              <button type="submit" style={controls.dangerButton} disabled={busy} data-testid="account-delete-send-code">
                E-mail me a code
              </button>
            </Form>
          )}
        </div>
      )}

      <p style={{ ...styles.text, marginTop: '1.25rem' }}>
        <Link to="/me" style={styles.link}>
          Keep my account
        </Link>
      </p>
    </DashboardPage>
  );
}
