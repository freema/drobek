/**
 * /me/api-keys — client half (M2-04, NSO-284): the user's personal `drk_` API
 * keys for MCP clients that cannot run OAuth (CI, scripts). A create form
 * (name + scope checkboxes), the new key shown ONCE in the create response,
 * and a list with last use + a revoke button. Client-safe: everything arrives
 * pre-shaped from ./me.api-keys.server.ts.
 */
import { Form, useActionData, useLoaderData } from 'react-router';
import { DashboardPage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './me.api-keys.server.js';

export function meta() {
  return [{ title: 'API keys — drobek' }];
}

const SCOPE_HINT: Record<string, string> = {
  read: 'list apps, read files and logs',
  write: 'create apps, write files, configure modules',
  publish: 'publish a version to the production URL',
};

const styles = {
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
  created: {
    margin: '1.25rem 0',
    padding: '0.9rem 1rem',
    border: '1px solid #86efac',
    background: '#f0fdf4',
    borderRadius: '10px',
  },
  keyValue: {
    display: 'block',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.9rem',
    padding: '0.5rem 0.6rem',
    margin: '0.5rem 0',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '6px',
    wordBreak: 'break-all',
    userSelect: 'all',
  },
  error: {
    margin: '1rem 0',
    padding: '0.6rem 0.9rem',
    border: '1px solid #fca5a5',
    background: '#fef2f2',
    color: '#991b1b',
    borderRadius: '8px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.6rem',
    padding: '0.9rem 1rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    background: '#fafafa',
  },
  label: { fontWeight: 600, fontSize: '0.9rem' },
  input: { ...controls.input, maxWidth: '24rem' },
  check: { display: 'flex', gap: '0.45rem', alignItems: 'baseline', fontSize: '0.9rem' },
  button: { ...controls.button, alignSelf: 'flex-start' },
  revoke: { ...controls.secondaryButton, color: '#991b1b', border: '1px solid #fca5a5' },
  list: { listStyle: 'none', padding: 0, margin: '1rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.7rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
    flexWrap: 'wrap',
  },
  itemRevoked: { opacity: 0.6 },
  name: { fontWeight: 700 },
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
  empty: { color: '#555', fontStyle: 'italic' },
} as const;

export default function ApiKeysRoute() {
  const { keys, scopes, mcpUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const created = actionData && actionData.ok ? actionData.created : null;
  const error = actionData && !actionData.ok ? actionData.error : null;

  return (
    <DashboardPage crumbs={[{ label: 'Account', to: '/me' }, { label: 'API keys' }]}>

      <h1 style={styles.h1}>API keys</h1>
      <p style={styles.hint}>
        Personal keys for MCP clients that cannot sign in with OAuth (CI, scripts). Send one as{' '}
        <span style={styles.mono}>Authorization: Bearer drk_…</span> to{' '}
        <span style={styles.mono}>{mcpUrl}</span>. A key acts as you, in every workspace you belong
        to, within its scopes.
      </p>

      {created ? (
        <div style={styles.created} data-testid="api-key-created" data-key-id={created.id}>
          <strong>Key “{created.name}” created.</strong> Copy it now — it is shown only once and
          drobek does not keep it.
          <code style={styles.keyValue} data-testid="api-key-value">
            {created.key}
          </code>
          <span style={styles.meta}>Scopes: {created.scopes.join(', ')}</span>
        </div>
      ) : null}

      {error ? (
        <p style={styles.error} role="alert" data-testid="api-key-error">
          {error}
        </p>
      ) : null}

      <h2 style={styles.h2}>Create a key</h2>
      <Form method="post" style={styles.form} data-testid="api-key-create-form">
        <input type="hidden" name="intent" value="create" />
        <label style={styles.label} htmlFor="api-key-name">
          Name
        </label>
        <input
          id="api-key-name"
          name="name"
          required
          maxLength={80}
          placeholder="e.g. CI deploy"
          style={styles.input}
          data-testid="api-key-name"
        />
        <span style={styles.label}>Scopes</span>
        {scopes.map((s) => (
          <label key={s} style={styles.check}>
            <input
              type="checkbox"
              name="scope"
              value={s}
              defaultChecked={s !== 'publish'}
              data-testid={`api-key-scope-${s}`}
            />
            <span>
              <strong>{s}</strong> <span style={styles.meta}>— {SCOPE_HINT[s] ?? ''}</span>
            </span>
          </label>
        ))}
        <button type="submit" style={styles.button} data-testid="api-key-create">
          Create key
        </button>
      </Form>

      <h2 style={styles.h2}>Your keys</h2>
      {keys.length === 0 ? (
        <p style={styles.empty} data-testid="api-keys-empty">
          No API keys yet.
        </p>
      ) : (
        <ul style={styles.list} data-testid="api-keys">
          {keys.map((k) => (
            <li
              key={k.id}
              style={k.status === 'revoked' ? { ...styles.item, ...styles.itemRevoked } : styles.item}
              data-testid="api-key-row"
              data-key-id={k.id}
              data-status={k.status}
            >
              <div>
                <div>
                  <span style={styles.name}>{k.name}</span>{' '}
                  {k.scopes.map((s) => (
                    <span key={s} style={styles.scope}>
                      {s}
                    </span>
                  ))}
                </div>
                <div style={styles.meta}>
                  created {k.created} · last used{' '}
                  <span data-testid="api-key-last-used">{k.lastUsed}</span>
                  {k.revoked ? ` · revoked ${k.revoked}` : ''}
                </div>
              </div>
              {k.status === 'active' ? (
                <Form method="post" style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="intent" value="revoke" />
                  <input type="hidden" name="id" value={k.id} />
                  <button type="submit" style={styles.revoke} data-testid="api-key-revoke">
                    Revoke
                  </button>
                </Form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DashboardPage>
  );
}
