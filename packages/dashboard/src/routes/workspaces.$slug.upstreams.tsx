/**
 * /workspaces/:slug/upstreams — client half (PHY-59): the BFF proxy config.
 * Lists registered upstreams (name / base URL / methods / path prefixes / auth
 * type — NEVER the secret, only "set" vs "none") and a register form whose secret
 * field is WRITE-ONLY. workspace-admin / super-admin only (the server gate is the
 * source of truth; the workspace page hides the link for everyone else).
 */
import { Form, useActionData, useLoaderData } from 'react-router';
import { WorkspacePage, controls } from '@drobek/tenancy/layout';
import type { action, loader } from './workspaces.$slug.upstreams.server.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [
    { title: `Upstreams — ${data?.workspace.name ?? 'Workspace'} — drobek` },
  ];
}

const styles = {
  h2: { fontSize: '1.15rem', marginTop: '2.25rem', marginBottom: '0.5rem' },
  intro: { color: '#3f3f46', margin: '1.25rem 0 0', fontSize: '0.95rem', maxWidth: '46rem' },
  hint: { color: '#71717a', margin: '0.5rem 0 0', fontSize: '0.85rem', maxWidth: '46rem' },
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  item: {
    padding: '0.75rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
  },
  itemHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  name: { fontWeight: 700 },
  base: { color: '#1e3a8a', fontSize: '0.85rem', wordBreak: 'break-all' },
  meta: { color: '#555', fontSize: '0.8rem', marginTop: '0.3rem' },
  badge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    border: '1px solid #d4d4d8',
    color: '#3f3f46',
    background: '#fafafa',
  },
  secretSet: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#166534',
    background: '#dcfce7',
    border: '1px solid #bbf7d0',
  },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginBottom: '0.35rem',
    marginTop: '0.9rem',
  },
  form: { maxWidth: '32rem' },
  input: { ...controls.input, width: '100%' },
  select: { ...controls.select, width: '100%' },
  button: { ...controls.button, marginTop: '0.9rem' },
  deleteBtn: { ...controls.secondaryButton, color: '#b91c1c', border: '1px solid #fecaca' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
} as const;

export default function UpstreamsRoute() {
  const { nav, upstreams, allowedPorts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const error = actionData && 'error' in actionData ? actionData.error : null;
  const errorCode = actionData && 'code' in actionData ? actionData.code : undefined;

  return (
    <WorkspacePage workspace={nav} section="upstreams">
      <p style={styles.intro} data-testid="upstreams-intro">
        An upstream is an external API your apps may call, such as a weather service, your CRM or a payment provider.
        You register its base URL and the methods and paths apps may use; your agent then gives an app access through
        the proxy module (you confirm that on the app&apos;s Modules page), and the app calls it through its own
        address. The secret is entered only here, by you: drobek adds it to every forwarded request, and neither the
        app&apos;s code nor the agent ever sees it.
      </p>
      <p style={styles.hint}>
        drobek forwards only the methods and path prefixes you allow, to public hosts on ports {allowedPorts.join('/')}{' '}
        only; the proxy config of each app also says which of its users may call the upstream.
      </p>

      {error ? (
        <p style={styles.error} data-testid="upstream-error" data-error-code={errorCode}>
          {error}
        </p>
      ) : null}

      {upstreams.length === 0 ? (
        <p style={styles.empty} data-testid="upstreams-empty">
          No upstreams yet.
        </p>
      ) : (
        <ul style={styles.list} data-testid="upstreams-list">
          {upstreams.map((u) => (
            <li
              key={u.id}
              style={styles.item}
              data-testid="upstream-row"
              data-upstream-name={u.name}
            >
              <div style={styles.itemHead}>
                <span style={styles.name}>{u.name}</span>
                <span style={styles.badge} data-testid="upstream-auth">
                  {u.authType}
                </span>
                {u.hasSecret ? (
                  <span style={styles.secretSet} data-testid="upstream-secret">
                    secret set
                  </span>
                ) : (
                  <span style={styles.badge} data-testid="upstream-secret">
                    no secret
                  </span>
                )}
                <Form method="post" style={{ marginLeft: 'auto' }}>
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={u.id} />
                  <button
                    type="submit"
                    style={styles.deleteBtn}
                    data-testid="upstream-delete"
                  >
                    Delete
                  </button>
                </Form>
              </div>
              <div style={styles.base} data-testid="upstream-base">
                {u.baseUrl}
              </div>
              <div style={styles.meta}>
                methods: {u.allowedMethods.join(', ')} · paths:{' '}
                {u.allowedPathPrefixes.join(', ')}
              </div>
            </li>
          ))}
        </ul>
      )}

      <section data-testid="add-upstream">
        <h2 style={styles.h2}>Register an upstream</h2>
        <Form method="post" style={styles.form}>
          <input type="hidden" name="intent" value="create" />
          <label htmlFor="up-name" style={styles.label}>
            Name
          </label>
          <input
            id="up-name"
            name="name"
            style={styles.input}
            placeholder="my-api"
            data-testid="field-name"
          />
          <label htmlFor="up-base" style={styles.label}>
            Base URL (https, public host, port {allowedPorts.join(' or ')})
          </label>
          <input
            id="up-base"
            name="baseUrl"
            style={styles.input}
            placeholder="https://api.example.com/v1"
            data-testid="field-baseurl"
          />
          <label htmlFor="up-methods" style={styles.label}>
            Allowed methods (space/comma separated)
          </label>
          <input
            id="up-methods"
            name="methods"
            style={styles.input}
            defaultValue="GET"
            data-testid="field-methods"
          />
          <label htmlFor="up-paths" style={styles.label}>
            Allowed path prefixes (space/comma separated)
          </label>
          <input
            id="up-paths"
            name="pathPrefixes"
            style={styles.input}
            placeholder="/ /users"
            data-testid="field-paths"
          />
          <label htmlFor="up-auth" style={styles.label}>
            Auth type
          </label>
          <select
            id="up-auth"
            name="authType"
            defaultValue="none"
            style={styles.select}
            data-testid="field-authtype"
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="header">header</option>
          </select>
          <label htmlFor="up-header" style={styles.label}>
            Header name (only for auth type = header)
          </label>
          <input
            id="up-header"
            name="authHeaderName"
            style={styles.input}
            placeholder="X-Api-Key"
            data-testid="field-headername"
          />
          <label htmlFor="up-secret" style={styles.label}>
            Secret (write-only — never shown again after saving)
          </label>
          <input
            id="up-secret"
            name="secret"
            type="password"
            autoComplete="new-password"
            style={styles.input}
            data-testid="field-secret"
          />
          <button type="submit" style={styles.button} data-testid="upstream-submit">
            Register upstream
          </button>
        </Form>
      </section>
    </WorkspacePage>
  );
}
