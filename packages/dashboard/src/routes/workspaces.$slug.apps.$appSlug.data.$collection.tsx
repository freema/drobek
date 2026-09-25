/**
 * /workspaces/:slug/apps/:appSlug/data/:collection — client half:
 * the collection TABLE. Columns are the required-schema properties (schema
 * order); rows are records newest-first; non-schema keys sit under a per-row
 * expander. A field FILTER + a SORT submit as GET params (round-tripped through
 * the loader → the data module's records query). A read-only JSON viewer opens for one record.
 * An editor+ may delete a record via a confirm step, edit one in a JSON
 * editor (validated by the data module), import a CSV file (all or nothing)
 * and delete the whole collection after typing its name; a viewer sees none
 * of these controls. All values arrive pre-shaped — this file stays
 * client-safe (imports only react-router + server-free helpers).
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import type {
  action,
  loader,
} from './workspaces.$slug.apps.$appSlug.data.$collection.server.js';
import { controls } from '@drobek/tenancy/layout';
import { AppPage } from '../app-header.js';
import { ui } from '../owner-ui.js';
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
  headRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
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
  toolbar: ui.toolbar,
  field: controls.field,
  label: controls.label,
  input: controls.input,
  applyBtn: controls.button,
  clearLink: controls.link,
  csvLink: { ...controls.link, color: '#1e3a8a', marginLeft: 'auto' },
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
  delBtn: controls.dangerButton,
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
  notice: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  ownerBar: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    flexWrap: 'wrap',
    margin: '0.75rem 0',
    fontSize: '0.85rem',
  },
  textarea: {
    width: '100%',
    minHeight: '14rem',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.8rem',
    padding: '0.6rem',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    boxSizing: 'border-box',
  },
  editBtn: controls.button,
} as const;

export default function CollectionTableRoute() {
  const {
    workspace,
    appSlug,
    header,
    collection,
    columns,
    rows,
    nextCursor,
    query,
    baseSearch,
    confirmId,
    openRecord,
    canDelete,
    editRecord,
    dropOpen,
    imported,
    importMaxRows,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const dataBase = `/workspaces/${workspace.slug}/apps/${appSlug}/data`;
  const collBase = `${dataBase}/${collection.name}`;
  const sortOptions = [...columns.map((c) => c.key), '_created_at', '_updated_at'];
  const failed = actionData && 'error' in actionData ? actionData : null;
  // A failed save keeps the owner's text in the editor.
  const editJson = failed?.intent === 'update' && 'json' in failed ? String(failed.json) : editRecord?.json ?? '';

  return (
    <AppPage header={header} trail={[{ label: collection.name }]}>
      <div style={{ ...styles.headRow, margin: '1.75rem 0 0.25rem' }}>
        <h2 style={{ ...ui.title, margin: 0 }}>{collection.name}</h2>
        <span style={{ ...styles.badge, textTransform: 'none', letterSpacing: 0 }} data-testid="collection-rules">
          {collection.rules}
        </span>
      </div>

      {failed ? (
        <div style={styles.error} role="alert" data-testid="data-error" data-intent={failed.intent}>
          {failed.error}
        </div>
      ) : null}

      {imported !== null ? (
        <div style={styles.notice} role="status" data-testid="import-done">
          Imported {imported} {imported === 1 ? 'record' : 'records'}.
        </div>
      ) : null}

      {/* The owner's collection tools (editor+): CSV import, delete the collection. */}
      {canDelete ? (
        <div style={styles.ownerBar} data-testid="owner-tools">
          <Form method="post" encType="multipart/form-data" style={styles.ownerBar} data-testid="import-form">
            <input type="hidden" name="intent" value="import" />
            <label style={styles.label} htmlFor="import-file">
              Import CSV
            </label>
            <input id="import-file" type="file" name="file" accept=".csv,text/csv" required data-testid="import-file" />
            <button type="submit" style={styles.applyBtn} data-testid="import-submit">
              Import
            </button>
            <span style={{ color: '#71717a' }}>
              header = field names, ≤ {importMaxRows} rows, all or nothing
            </span>
          </Form>
          <Link to={`${collBase}?drop=1`} style={{ ...styles.delLink, marginLeft: 'auto' }} data-testid="drop-link">
            Delete collection…
          </Link>
        </div>
      ) : null}

      {dropOpen ? (
        <Form method="post" style={styles.modal} data-testid="drop-form">
          <input type="hidden" name="intent" value="drop-collection" />
          <p style={{ margin: '0 0 0.5rem' }}>
            This deletes <strong>{collection.name}</strong> — its {collection.records}{' '}
            {collection.records === 1 ? 'record' : 'records'} and its declaration in the app&apos;s data config. The app&apos;s
            code that uses it will get 404s. Type the collection name to confirm.
          </p>
          <input name="confirm_name" autoComplete="off" style={styles.input} aria-label="Collection name" data-testid="drop-confirm-name" />{' '}
          <button type="submit" style={styles.delBtn} data-testid="drop-confirm">
            Delete collection
          </button>{' '}
          <Link to={collBase} style={styles.actionLink} data-testid="drop-cancel">
            Cancel
          </Link>
        </Form>
      ) : null}

      {/* The JSON editor for one record (editor+). */}
      {editRecord ? (
        <Form method="post" style={styles.modal} aria-label="Edit record" data-testid="edit-form">
          <div style={styles.modalHead}>
            <strong style={styles.mono}>Edit {editRecord.id}</strong>
            <span style={{ color: '#71717a', fontSize: '0.8rem' }}>
              the record&apos;s own fields as JSON; _id, _owner and the times stay
            </span>
          </div>
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="id" value={editRecord.id} />
          <textarea key={editJson} name="json" defaultValue={editJson} style={styles.textarea} spellCheck={false} data-testid="edit-json" />
          <div style={{ marginTop: '0.5rem' }}>
            <button type="submit" style={styles.editBtn} data-testid="edit-save">
              Save
            </button>{' '}
            <Link to={`${collBase}${toSearch(baseSearch)}`} style={styles.actionLink} data-testid="edit-cancel">
              Cancel
            </Link>
          </div>
        </Form>
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
                      <Link
                        to={`${collBase}${toSearch(baseSearch, { edit: r.id })}`}
                        style={styles.actionLink}
                        data-testid="record-edit"
                      >
                        Edit
                      </Link>
                    ) : null}
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
    </AppPage>
  );
}
