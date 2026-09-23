/**
 * /workspaces/:slug/apps/:appSlug/domains — client half (M3-01): the app's
 * custom domains. Add a domain → the two DNS records to create → "Verify"
 * (the server looks both up now) → the domain serves the published version.
 * A verified domain can be made primary (the drobek address then redirects
 * there). Controls render for editor+ only; the action re-enforces the role.
 * Server code lives in the .server.ts.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { DomainsActionData, loader } from './workspaces.$slug.apps.$appSlug.domains.server.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Domains — ${data?.app.slug ?? 'App'} — drobek` }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '48rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  nav: { margin: '0 0 1.5rem', fontSize: '0.9rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap' },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  addRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '1rem 0' },
  input: {
    flex: '1 1 16rem',
    padding: '0.45rem 0.6rem',
    fontSize: '0.95rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '7px',
  },
  button: {
    padding: '0.4rem 0.8rem',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  ghost: {
    padding: '0.35rem 0.7rem',
    fontSize: '0.82rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  danger: {
    padding: '0.35rem 0.7rem',
    fontSize: '0.82rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#991b1b',
    background: '#fff',
    border: '1px solid #fecaca',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  card: { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.9rem 1rem', marginBottom: '0.9rem', background: '#fcfcfd' },
  cardHead: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  host: { fontWeight: 700, fontFamily: 'ui-monospace, monospace', fontSize: '0.95rem' },
  ok: {
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
  pending: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#92400e',
    background: '#fef3c7',
    border: '1px solid #fde68a',
  },
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
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', margin: '0.6rem 0' },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.35rem 0.5rem 0.35rem 0',
    color: '#555',
    fontSize: '0.74rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  td: { borderBottom: '1px solid #f0f0f2', padding: '0.45rem 0.5rem 0.45rem 0', verticalAlign: 'top' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem', wordBreak: 'break-all' },
  meta: { fontSize: '0.8rem', color: '#71717a', margin: '0.3rem 0 0' },
  problem: { fontSize: '0.85rem', color: '#7f1d1d', margin: '0.4rem 0 0' },
  actions: { display: 'flex', gap: '0.45rem', flexWrap: 'wrap', marginTop: '0.6rem' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  notice: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  muted: { color: '#8a8a8e' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function AppDomainsRoute() {
  const { workspace, app, cnameTarget, maxPerApp, canEdit, domains } = useLoaderData<typeof loader>();
  const result = useActionData<DomainsActionData>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const appUrl = `/workspaces/${workspace.slug}/apps/${app.slug}`;

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link to={appUrl} style={styles.navLink}>
          ← {app.slug}
        </Link>
        <Link to={`${appUrl}/data`} style={styles.navLink}>
          Data
        </Link>
      </p>

      <h1 style={styles.h1}>Custom domains</h1>
      <p style={styles.hint}>
        Serve the published version of <strong>{app.slug}</strong> on a domain you own. It stays available at{' '}
        <code style={styles.mono}>{app.defaultUrl}</code>. Up to {maxPerApp} domain{maxPerApp === 1 ? '' : 's'} per app.
      </p>

      {result ? (
        result.ok ? (
          <div style={styles.notice} role="status" data-testid="domain-notice">
            {result.message}
          </div>
        ) : (
          <div style={styles.error} role="alert" data-testid="domain-error" data-code={result.code}>
            {result.error} <span style={styles.muted}>({result.code})</span>
          </div>
        )
      ) : null}

      {canEdit ? (
        <Form method="post" style={styles.addRow} data-testid="domain-add-form">
          <input type="hidden" name="intent" value="add" />
          <input
            name="hostname"
            placeholder="shop.example.com"
            aria-label="Domain name"
            autoComplete="off"
            spellCheck={false}
            required
            style={styles.input}
            data-testid="domain-input"
          />
          <button type="submit" style={styles.button} disabled={busy} data-testid="domain-add">
            Add domain
          </button>
        </Form>
      ) : null}

      <h2 style={styles.h2}>Domains</h2>
      {domains.length === 0 ? (
        <p style={styles.muted} data-testid="domains-empty">
          No custom domains yet.
        </p>
      ) : (
        domains.map((d) => (
          <section key={d.id} style={styles.card} data-testid="domain-row" data-hostname={d.hostname} data-verified={d.verified ? 'true' : 'false'}>
            <div style={styles.cardHead}>
              <span style={styles.host}>{d.hostname}</span>
              {d.verified ? (
                <span style={styles.ok} data-testid="domain-status">
                  verified
                </span>
              ) : (
                <span style={styles.pending} data-testid="domain-status">
                  not verified
                </span>
              )}
              {d.isPrimary ? (
                <span style={styles.badge} data-testid="domain-primary">
                  primary
                </span>
              ) : null}
            </div>

            {d.verified ? (
              <p style={styles.meta}>
                Verified {formatTimestamp(d.verifiedAt)} · last checked {formatTimestamp(d.lastCheckAt)}
                {d.certState === 'requested' ? ' · certificate requested' : ''}
                {d.isPrimary ? ` · ${app.defaultUrl} redirects here` : ''}
              </p>
            ) : (
              <div data-testid="domain-instructions">
                <p style={styles.meta}>
                  Create these two records at your DNS provider, then click Verify. DNS changes can take a while to
                  propagate.
                </p>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Type</th>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={styles.td}>CNAME</td>
                      <td style={{ ...styles.td, ...styles.mono }} data-testid="cname-name">
                        {d.instructions.cname.name}
                      </td>
                      <td style={{ ...styles.td, ...styles.mono }} data-testid="cname-value">
                        {d.instructions.cname.value}
                      </td>
                    </tr>
                    <tr>
                      <td style={styles.td}>TXT</td>
                      <td style={{ ...styles.td, ...styles.mono }} data-testid="txt-name">
                        {d.instructions.txt.name}
                      </td>
                      <td style={{ ...styles.td, ...styles.mono }} data-testid="txt-value">
                        {d.instructions.txt.value}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p style={styles.meta}>
                  An apex domain (example.com) cannot have a CNAME: use your provider&apos;s ALIAS / ANAME (CNAME
                  flattening) record pointing to <code style={styles.mono}>{cnameTarget}</code> instead.
                </p>
              </div>
            )}

            {d.lastError ? (
              <p style={styles.problem} data-testid="domain-last-error">
                Last check {formatTimestamp(d.lastCheckAt)}: {d.lastError}
              </p>
            ) : null}

            {canEdit ? (
              <div style={styles.actions}>
                <Form method="post">
                  <input type="hidden" name="intent" value="verify" />
                  <input type="hidden" name="id" value={d.id} />
                  <button type="submit" style={styles.ghost} disabled={busy} data-testid="domain-verify">
                    {d.verified ? 'Check again' : 'Verify'}
                  </button>
                </Form>
                {d.verified && !d.isPrimary ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="primary" />
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" style={styles.ghost} disabled={busy} data-testid="domain-make-primary">
                      Make primary
                    </button>
                  </Form>
                ) : null}
                {d.isPrimary ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="unprimary" />
                    <button type="submit" style={styles.ghost} disabled={busy} data-testid="domain-unprimary">
                      Stop redirecting
                    </button>
                  </Form>
                ) : null}
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!window.confirm(`Remove ${d.hostname}? The app stops answering on it right away.`)) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="id" value={d.id} />
                  <button type="submit" style={styles.danger} disabled={busy} data-testid="domain-remove">
                    Remove
                  </button>
                </Form>
              </div>
            ) : null}
          </section>
        ))
      )}

      <p style={styles.back}>
        <Link to={appUrl}>← Back to {app.slug}</Link>
      </p>
    </main>
  );
}
