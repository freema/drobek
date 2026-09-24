/**
 * /workspaces/:slug/apps/:appSlug/data — client half: the Data
 * tab's COLLECTIONS list (the data module's declared collections). Each
 * collection links to its table view. Below it, ORPHANS (NSO-324): records of
 * collections the config no longer declares, with a purge form (editor+, the
 * owner types the name). Minimal style (mirrors the apps/app-detail pages).
 * Server code lives in the .server.ts; all values arrive pre-shaped so this
 * file stays client-safe.
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.data.server.js';
import { AppSubnav, ui } from '../owner-ui.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [{ title: `Data — ${data?.appSlug ?? 'App'} — drobek` }];
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
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
    display: 'flex',
    gap: '0.9rem',
    flexWrap: 'wrap',
  },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.75rem 0.9rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
    flexWrap: 'wrap',
  },
  collLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none' },
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
  count: { color: '#3f3f46', fontSize: '0.85rem', fontWeight: 600 },
  summary: {
    color: '#8a8a8e',
    fontSize: '0.82rem',
    fontFamily: 'ui-monospace, monospace',
    marginLeft: 'auto',
  },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
  h2: { fontSize: '1.1rem', margin: '2rem 0 0.25rem' },
  purgeForm: { display: 'flex', gap: '0.4rem', alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' },
  input: { fontFamily: 'inherit', fontSize: '0.85rem', padding: '0.3rem 0.45rem', border: '1px solid #d4d4d8', borderRadius: '6px' },
  purgeBtn: {
    padding: '0.3rem 0.7rem',
    fontSize: '0.82rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#b91c1c',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  error: { color: '#b91c1c', fontSize: '0.9rem' },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function AppDataRoute() {
  const { workspace, appSlug, collections, dropped, orphans, canPurge, purged } = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();

  return (
    <main style={styles.main}>
      <AppSubnav workspaceSlug={workspace.slug} appSlug={appSlug} current="data" />

      <h1 style={styles.h1}>Data</h1>
      <p style={styles.hint}>
        Collections stored by <strong>{appSlug}</strong> (the data module; preview and production share them).
      </p>

      {dropped ? (
        <div style={ui.notice} role="status" data-testid="collection-dropped">
          Collection <strong>{dropped}</strong> deleted.
        </div>
      ) : null}

      {purged ? (
        <div style={ui.notice} role="status" data-testid="orphan-purged">
          Orphan records of <strong>{purged}</strong> purged.
        </div>
      ) : null}

      {collections.length === 0 ? (
        <p style={styles.empty} data-testid="collections-empty">
          No collections yet — an agent declares them with configure_module('data', …).
        </p>
      ) : (
        <ul style={styles.list} data-testid="collections-list">
          {collections.map((c) => (
            <li
              key={c.name}
              style={styles.item}
              data-testid="collection-row"
              data-collection={c.name}
            >
              <Link
                to={`/workspaces/${workspace.slug}/apps/${appSlug}/data/${c.name}`}
                style={styles.collLink}
                data-testid="collection-link"
              >
                {c.name}
              </Link>
              <span style={styles.count} data-testid="collection-count">
                {c.recordCount} {c.recordCount === 1 ? 'record' : 'records'}
              </span>
              <span style={{ ...styles.badge, textTransform: 'none', letterSpacing: 0 }} data-testid="collection-rules">
                {c.rules}
              </span>
              <span style={styles.summary} title="schema fields">
                {c.schemaSummary}
              </span>
            </li>
          ))}
        </ul>
      )}

      {orphans.length > 0 ? (
        <section data-testid="orphans">
          <h2 style={styles.h2}>Orphan records</h2>
          <p style={styles.hint}>
            Records of collections the data config no longer declares. The app cannot read them, but they count towards its storage
            limits. Purging deletes them permanently.
          </p>
          {failed && 'error' in failed ? (
            <p style={styles.error} role="alert" data-testid="orphan-error">
              {failed.error}
            </p>
          ) : null}
          <ul style={styles.list}>
            {orphans.map((o) => (
              <li key={o.name} style={styles.item} data-testid="orphan-row" data-collection={o.name}>
                <strong>{o.name}</strong>
                <span style={styles.count} data-testid="orphan-count">
                  {o.records} {o.records === 1 ? 'record' : 'records'}
                </span>
                {canPurge ? (
                  <Form method="post" style={styles.purgeForm} data-testid="orphan-purge-form">
                    <input type="hidden" name="intent" value="purge-orphan" />
                    <input type="hidden" name="collection" value={o.name} />
                    <input
                      name="confirm_name"
                      autoComplete="off"
                      placeholder={`type ${o.name} to confirm`}
                      aria-label={`Type ${o.name} to confirm`}
                      style={styles.input}
                      data-testid="orphan-confirm-name"
                    />
                    <button type="submit" style={styles.purgeBtn} data-testid="orphan-purge">
                      Purge
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p style={styles.back}>
        <Link to={`/workspaces/${workspace.slug}/apps/${appSlug}`}>
          ← Back to {appSlug}
        </Link>
      </p>
    </main>
  );
}
