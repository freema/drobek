/**
 * /workspaces/:slug/apps/:appSlug/domains — client half (M3-01): the app's
 * custom domains. Add a domain → the two DNS records to create → "Verify"
 * (the server looks both up now) → the domain serves the published version.
 * A verified domain can be made primary (the drobek address then redirects
 * there). Controls render for editor+ only; the action re-enforces the role.
 * Server code lives in the .server.ts.
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { controls } from '@drobek/tenancy/layout';
import { AppPage } from '../app-header.js';
import type { DomainsActionData, loader } from './workspaces.$slug.apps.$appSlug.domains.server.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Domains — ${data?.app.slug ?? 'App'} — drobek` }];
}

const styles = {
  title: { fontSize: '1.15rem', margin: '1.75rem 0 0.25rem' },
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  addRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '1rem 0' },
  input: { ...controls.input, flex: '1 1 16rem' },
  button: controls.button,
  ghost: controls.secondaryButton,
  danger: { ...controls.secondaryButton, color: '#991b1b', border: '1px solid #fecaca' },
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
} as const;

export default function AppDomainsRoute() {
  const { app, header, cnameTarget, maxPerApp, canEdit, domains } = useLoaderData<typeof loader>();
  const result = useActionData<DomainsActionData>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';

  return (
    <AppPage header={header}>
      <h2 style={styles.title}>Custom domains</h2>
      <p style={styles.hint}>
        Serve the published version of <strong>{app.slug}</strong> on a domain you own. It stays available at{' '}
        <code style={styles.mono}>{app.defaultUrl}</code>.
        {maxPerApp > 0 ? ` Up to ${maxPerApp} domain${maxPerApp === 1 ? '' : 's'} per app.` : null}
      </p>
      {maxPerApp === 0 ? (
        <div style={styles.error} role="status" data-testid="domains-disabled">
          Custom domains are not available for this workspace: its limit is 0 domains per app (DOMAINS_MAX_PER_APP).
          The workspace&apos;s plan or the server operator decides it.
        </div>
      ) : null}

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

      {canEdit && maxPerApp > 0 ? (
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
    </AppPage>
  );
}
