/**
 * /workspaces/:slug/apps/:appSlug/data/:collection — client half (M1b, PHY-121):
 * the collection TABLE. Columns are the required-schema properties (schema
 * order); rows are records newest-first; non-schema keys sit under a per-row
 * expander. A field FILTER + a SORT submit as GET params (round-tripped through
 * the loader → the U10 query API). A read-only JSON viewer opens for one record.
 * An editor+ may delete a record via a confirm step; a viewer sees no delete
 * control. All values arrive pre-shaped — this file stays client-safe (imports
 * only react-router + the server-free ../view.js).
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import type {
  action,
  loader,
} from './workspaces.$slug.apps.$appSlug.data.$collection.server.js';
import { formatTimestamp } from '../view.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [
    { title: `${data?.collection.name ?? 'Data'} — ${data?.appSlug ?? ''} — drobek` },
  ];
}

/** Append/override params onto the filter+sort base search string. */
function toSearch(base: string, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams(base);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '60rem',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  nav: {
    margin: '0 0 1.5rem',
    fontSize: '0.9rem',
    display: 'flex',
    gap: '0.9rem',
    flexWrap: 'wrap',
  },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  h1: { fontSize: '1.6rem', margin: 0 },
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
  toolbar: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    margin: '1.25rem 0 0.75rem',
    padding: '0.75rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    background: '#fafafa',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  label: {
    fontSize: '0.68rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#71717a',
    fontWeight: 700,
  },
  input: {
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    padding: '0.3rem 0.45rem',
    border: '1px solid #d4d4d8',
    borderRadius: '6px',
  },
  applyBtn: {
    padding: '0.4rem 0.85rem',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
  },
  clearLink: { fontSize: '0.85rem', color: '#555', alignSelf: 'center' },
  csvLink: { fontSize: '0.85rem', color: '#1e3a8a', marginLeft: 'auto', alignSelf: 'center' },
  tableWrap: { overflowX: 'auto', margin: '0.5rem 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.45rem 0.6rem 0.45rem 0',
    color: '#555',
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },
  td: {
    borderBottom: '1px solid #f0f0f2',
    padding: '0.5rem 0.6rem 0.5rem 0',
    verticalAlign: 'top',
  },
  req: { color: '#b91c1c' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' },
  pre: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.78rem',
    background: '#f8f8fa',
    border: '1px solid #ececef',
    borderRadius: '8px',
    padding: '0.75rem',
    overflowX: 'auto',
    margin: '0.4rem 0 0',
  },
  actionLink: { color: '#1e3a8a', fontSize: '0.8rem', marginRight: '0.6rem' },
  delLink: { color: '#b91c1c', fontSize: '0.8rem', cursor: 'pointer' },
  delBtn: {
    padding: '0.25rem 0.6rem',
    fontSize: '0.78rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#b91c1c',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  pager: { display: 'flex', gap: '1rem', margin: '1rem 0', fontSize: '0.88rem' },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  modal: {
    border: '1px solid #d4d4d8',
    borderRadius: '10px',
    padding: '1rem',
    margin: '1rem 0',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  modalHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    marginBottom: '0.4rem',
  },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function CollectionTableRoute() {
  const {
    workspace,
    appSlug,
    collection,
    columns,
    rows,
    nextCursor,
    query,
    baseSearch,
    confirmId,
    openRecord,
    canDelete,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const dataBase = `/workspaces/${workspace.slug}/apps/${appSlug}/data`;
  const collBase = `${dataBase}/${collection.name}`;
  const sortOptions = [...columns.map((c) => c.key), 'createdAt', 'updatedAt'];

  return (
    <main style={styles.main}>
      <p style={styles.nav}>
        <Link to={dataBase} style={styles.navLink}>
          ← Data
        </Link>
        <Link to={`/workspaces/${workspace.slug}/apps/${appSlug}`} style={styles.navLink}>
          {appSlug}
        </Link>
      </p>

      <div style={styles.headRow}>
        <h1 style={styles.h1}>{collection.name}</h1>
        <span style={styles.badge} data-testid="collection-access">
          {collection.accessMode}
        </span>
      </div>

      {actionData?.error ? (
        <div style={styles.error} role="alert" data-testid="data-error">
          {actionData.error}
        </div>
      ) : null}

      {/* FILTER + SORT — GET form, round-tripped through the loader. */}
      <Form method="get" style={styles.toolbar} data-testid="filter-form">
        <div style={styles.field}>
          <label style={styles.label} htmlFor="field">
            Filter field
          </label>
          <select
            id="field"
            name="field"
            defaultValue={query.field}
            style={styles.input}
            data-testid="filter-field"
          >
            <option value="">— none —</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="value">
            equals
          </label>
          <input
            id="value"
            name="value"
            defaultValue={query.value}
            style={styles.input}
            data-testid="filter-value"
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="sort">
            Sort
          </label>
          <select
            id="sort"
            name="sort"
            defaultValue={query.sortField}
            style={styles.input}
            data-testid="sort-field"
          >
            <option value="">newest first</option>
            {sortOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="dir">
            Dir
          </label>
          <select
            id="dir"
            name="dir"
            defaultValue={query.dir}
            style={styles.input}
            data-testid="sort-dir"
          >
            <option value="desc">desc</option>
            <option value="asc">asc</option>
          </select>
        </div>
        <button type="submit" style={styles.applyBtn} data-testid="filter-apply">
          Apply
        </button>
        <Link to={collBase} style={styles.clearLink} data-testid="filter-clear">
          Clear
        </Link>
        <a
          href={`${collBase}/export.csv${toSearch(baseSearch)}`}
          style={styles.csvLink}
          data-testid="csv-export"
        >
          ↓ Export CSV
        </a>
      </Form>

      {/* Read-only JSON viewer for one record. */}
      {openRecord ? (
        <div style={styles.modal} role="dialog" aria-label="Record" data-testid="record-modal">
          <div style={styles.modalHead}>
            <strong style={styles.mono}>{openRecord.id}</strong>
            <span style={styles.badge}>{formatTimestamp(openRecord.createdAt)}</span>
            <Link
              to={`${collBase}${toSearch(baseSearch)}`}
              style={{ ...styles.actionLink, marginLeft: 'auto' }}
              data-testid="record-close"
            >
              Close
            </Link>
          </div>
          <pre style={styles.pre} data-testid="record-json">
            {openRecord.json}
          </pre>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p style={styles.empty} data-testid="records-empty">
          No records match.
        </p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table} data-testid="data-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} style={styles.th}>
                    {c.key}
                    {c.required ? <span style={styles.req}> *</span> : null}
                  </th>
                ))}
                <th style={styles.th}>created</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="data-row" data-record-id={r.id}>
                  {r.cells.map((cell, i) => (
                    <td key={columns[i].key} style={styles.td} data-testid="data-cell">
                      {cell}
                    </td>
                  ))}
                  <td style={styles.td} data-testid="data-created">
                    {formatTimestamp(r.createdAt)}
                  </td>
                  <td style={styles.td}>
                    <Link
                      to={`${collBase}${toSearch(baseSearch, { record: r.id })}`}
                      style={styles.actionLink}
                      data-testid="record-view"
                    >
                      View
                    </Link>
                    {canDelete ? (
                      confirmId === r.id ? (
                        <Form
                          method="post"
                          style={{ display: 'inline' }}
                          data-testid="delete-confirm-form"
                        >
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="field" value={query.field} />
                          <input type="hidden" name="value" value={query.value} />
                          <input type="hidden" name="sort" value={query.sortField} />
                          <input type="hidden" name="dir" value={query.dir} />
                          <button
                            type="submit"
                            style={styles.delBtn}
                            data-testid="delete-confirm"
                          >
                            Confirm delete
                          </button>{' '}
                          <Link
                            to={`${collBase}${toSearch(baseSearch)}`}
                            style={styles.actionLink}
                            data-testid="delete-cancel"
                          >
                            Cancel
                          </Link>
                        </Form>
                      ) : (
                        <Link
                          to={`${collBase}${toSearch(baseSearch, { confirm: r.id })}`}
                          style={styles.delLink}
                          data-testid="delete-link"
                        >
                          Delete
                        </Link>
                      )
                    ) : null}
                    {r.hasExtra && r.extraJson ? (
                      <details data-testid="row-extra" style={{ marginTop: '0.35rem' }}>
                        <summary style={styles.mono}>+ extra keys</summary>
                        <pre style={styles.pre}>{r.extraJson}</pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={styles.pager}>
        {baseSearch || nextCursor ? (
          <Link to={`${collBase}${toSearch(baseSearch)}`} data-testid="first-page">
            « First page
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            to={`${collBase}${toSearch(baseSearch, { cursor: nextCursor })}`}
            data-testid="next-page"
          >
            Next page »
          </Link>
        ) : null}
      </div>

      <p style={styles.back}>
        <Link to={dataBase}>← All collections</Link>
      </p>
    </main>
  );
}
