/**
 * /workspaces/:slug/apps/:appSlug/forms — client half of the Forms tab
 * (M2-03): the submissions the forms module stored for this app, newest
 * first, with a form + date-range filter (a GET form round-tripped through
 * the loader), a CSV export of the filtered rows, and (editor+) a delete with
 * a confirm step. Submitted values are visitor input: React escapes them.
 */
import { Form, Link, useActionData, useLoaderData } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.forms.server.js';
import { ModuleMissing, ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Forms — ${data?.appSlug ?? 'App'} — drobek` }];
}

function withParams(base: string, extra: Record<string, string>): string {
  const sp = new URLSearchParams(base);
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export default function AppFormsRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/forms`;

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Forms</h2>
      <p style={ui.hint}>
        Submissions of <strong>{d.appSlug}</strong>&apos;s forms (the forms module; preview and production share them).
      </p>

      {!d.enabled ? (
        <ModuleMissing does="stores form submissions" />
      ) : (
        <>
          {actionData && 'error' in actionData ? (
            <div style={ui.error} role="alert" data-testid="forms-error">
              {actionData.error}
            </div>
          ) : null}
          {d.error ? (
            <div style={ui.error} role="alert" data-testid="forms-error">
              {d.error}
            </div>
          ) : null}

          <Form method="get" style={ui.toolbar} data-testid="forms-filter">
            <div style={ui.field}>
              <label style={ui.label} htmlFor="form">
                Form
              </label>
              <select id="form" name="form" defaultValue={d.filter.form} style={ui.input} data-testid="forms-filter-form">
                <option value="">all forms</option>
                {d.forms.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name} ({f.submissions})
                  </option>
                ))}
              </select>
            </div>
            <div style={ui.field}>
              <label style={ui.label} htmlFor="from">
                From (UTC)
              </label>
              <input id="from" type="date" name="from" defaultValue={d.filter.from} style={ui.input} data-testid="forms-filter-from" />
            </div>
            <div style={ui.field}>
              <label style={ui.label} htmlFor="to">
                To (UTC, inclusive)
              </label>
              <input id="to" type="date" name="to" defaultValue={d.filter.to} style={ui.input} data-testid="forms-filter-to" />
            </div>
            <button type="submit" style={ui.button} data-testid="forms-filter-apply">
              Apply
            </button>
            <Link to={base} style={ui.controlLink}>
              Clear
            </Link>
            <a href={`${base}/export.csv${d.search ? `?${d.search}` : ''}`} style={{ ...ui.controlLink, color: '#1e3a8a', marginLeft: 'auto' }} data-testid="forms-csv">
              ↓ Export CSV
            </a>
          </Form>

          <p style={ui.muted} data-testid="forms-total">
            {d.total} {d.total === 1 ? 'submission' : 'submissions'}
          </p>

          {d.rows.length === 0 ? (
            <p style={ui.empty} data-testid="submissions-empty">
              No submissions match.
            </p>
          ) : (
            <div style={ui.tableWrap}>
              <table style={ui.table} data-testid="submissions-table">
                <thead>
                  <tr>
                    <th style={ui.th}>Received</th>
                    <th style={ui.th}>Form</th>
                    <th style={ui.th}>Fields</th>
                    <th style={ui.th}>Notified</th>
                    <th style={ui.th} />
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id} data-testid="submission-row" data-submission-id={r.id}>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(r.createdAt)}</td>
                      <td style={ui.td}>
                        <code style={ui.mono}>{r.form}</code>
                      </td>
                      <td style={ui.td} data-testid="submission-fields">
                        {r.fields.map(([k, v]) => (
                          <div key={k}>
                            <span style={ui.mono}>{k}</span>: {v}
                          </div>
                        ))}
                        {r.userId ? <div style={ui.muted}>signed in: {r.userId}</div> : null}
                      </td>
                      <td style={ui.td}>{r.notified ? <span style={ui.okBadge}>sent</span> : <span style={ui.badge}>no</span>}</td>
                      <td style={ui.td}>
                        {d.canDelete ? (
                          d.confirmId === r.id ? (
                            <Form method="post" style={{ display: 'inline' }} data-testid="submission-delete-form">
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="form" value={d.filter.form} />
                              <input type="hidden" name="from" value={d.filter.from} />
                              <input type="hidden" name="to" value={d.filter.to} />
                              <button type="submit" style={ui.dangerButton} data-testid="submission-delete-confirm">
                                Confirm delete
                              </button>{' '}
                              <Link to={`${base}${withParams(d.search, {})}`} style={ui.link}>
                                Cancel
                              </Link>
                            </Form>
                          ) : (
                            <Link to={`${base}${withParams(d.search, { confirm: r.id })}`} style={ui.dangerLink} data-testid="submission-delete">
                              Delete
                            </Link>
                          )
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={ui.pager}>
            {d.nextCursor ? (
              <>
                <Link to={`${base}${withParams(d.search, {})}`}>« First page</Link>
                <Link to={`${base}${withParams(d.search, { cursor: d.nextCursor })}`} data-testid="submissions-next">
                  Next page »
                </Link>
              </>
            ) : null}
          </div>
        </>
      )}
    </AppPage>
  );
}
