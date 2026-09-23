/**
 * /me/connections — client half (M2-04, NSO-284): the OAuth clients (coding
 * agents, IDEs) that hold access to the user's account, with a revoke button
 * per client. Client-safe: data arrives shaped from ./me.connections.server.ts.
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import type { action, loader } from './me.connections.server.js';

export function meta() {
  return [{ title: 'Connections — drobek' }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '46rem',
    margin: '0 auto',
    padding: '4rem 1.5rem 2rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  nav: { margin: '0 0 1.5rem', fontSize: '0.9rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  error: {
    margin: '1rem 0',
    padding: '0.6rem 0.9rem',
    border: '1px solid #fca5a5',
    background: '#fef2f2',
    color: '#991b1b',
    borderRadius: '8px',
  },
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
    flexWrap: 'wrap',
  },
  name: { fontWeight: 700 },
  clientId: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.75rem',
    color: '#555',
    wordBreak: 'break-all',
  },
  meta: { color: '#555', fontSize: '0.8rem' },
  scope: {
    display: 'inline-block',
    padding: '0.05rem 0.45rem',
    marginRight: '0.3rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    borderRadius: '999px',
    color: '#1e3a8a',
    background: '#dbeafe',
    border: '1px solid #bfdbfe',
  },
  revoke: {
    padding: '0.3rem 0.7rem',
    fontSize: '0.8rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#991b1b',
    background: '#fff',
    border: '1px solid #fca5a5',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  empty: { color: '#555', fontStyle: 'italic' },
} as const;

export default function ConnectionsRoute() {
  const { connections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const error = actionData && !actionData.ok ? actionData.error : null;

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link to="/me" style={styles.navLink}>
          ← Your account
        </Link>
        <Link to="/me/api-keys" style={styles.navLink}>
          API keys
        </Link>
      </p>

      <h1 style={styles.h1}>Connections</h1>
      <p style={styles.hint}>
        Coding agents and other MCP clients you approved. Revoking one signs it out at once: its
        next call is refused and it has to ask for your approval again.
      </p>

      {error ? (
        <p style={styles.error} role="alert" data-testid="connection-error">
          {error}
        </p>
      ) : null}

      {connections.length === 0 ? (
        <p style={styles.empty} data-testid="connections-empty">
          No connected clients.
        </p>
      ) : (
        <ul style={styles.list} data-testid="connections">
          {connections.map((c) => (
            <li
              key={c.id}
              style={styles.item}
              data-testid="connection-row"
              data-oauth-client-id={c.id}
              data-client-id={c.clientId}
              data-source={c.source}
            >
              <div>
                <div>
                  <span style={styles.name} data-testid="connection-name">
                    {c.name}
                  </span>{' '}
                  {c.scopes.map((s) => (
                    <span key={s} style={styles.scope}>
                      {s}
                    </span>
                  ))}
                </div>
                <div style={styles.clientId}>{c.clientId}</div>
                <div style={styles.meta}>
                  {c.sourceLabel} · last used <span data-testid="connection-last-used">{c.lastUsed}</span>
                </div>
              </div>
              <Form method="post" style={{ marginLeft: 'auto' }}>
                <input type="hidden" name="intent" value="revoke" />
                <input type="hidden" name="id" value={c.id} />
                <button type="submit" style={styles.revoke} data-testid="connection-revoke">
                  Revoke
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
