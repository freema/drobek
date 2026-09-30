/**
 * /workspaces/:slug/apps/:appSlug/forms — client half of the Forms tab
 *: the submissions the forms module stored for this app, newest
 * first, with a form + date-range filter (a GET form round-tripped through
 * the loader), a CSV export of the filtered rows, and (editor+) a delete with
 * a confirm step. Submitted values are visitor input: React escapes them.
 */
import { Form, Link, useActionData, useLoaderData, useLocation, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.forms.server.js';
import { AgentPrompt, ModuleMissing, ui } from '../owner-ui.js';
import { formsAgentPrompt, formsListState } from '../owner-view.js';
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
  const location = useLocation();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/forms`;
  const filtered = d.search !== '';
  const state = formsListState({ error: d.error, forms: d.forms, rows: d.rows.length, filtered });
  const loading = navigation.state === 'loading' && navigation.location?.pathname === base;
  const received = d.forms.reduce((n, f) => n + f.submissions, 0);

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Forms</h2>
      <p style={ui.hint}>
        Form submissions received by <strong>{d.appSlug}</strong>. The preview and the published app share their data, forms and
        uploads, so submissions from both appear together here.
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

          {state === 'no-forms' ? (
            <>
              <p style={ui.empty} data-testid="forms-none">
                This app has no forms yet: nothing was submitted and no form is configured. Once the app has a form (for
                example <code>&lt;Form name=&quot;contact&quot;&gt;</code>), every submission from the preview or the published
                app is listed here and e-mailed to the app&apos;s owners.
              </p>
              {d.canDelete ? (
                <AgentPrompt prompt={formsAgentPrompt(d.workspace.slug, d.appSlug)} testId="forms-agent-prompt" />
              ) : (
                <p style={ui.hint} data-testid="forms-ask-editor">
                  Adding a form changes the app&apos;s files: ask an editor of this workspace (or their coding agent) to add one.
                </p>
              )}
              {filtered ? (
                <Link to={base} style={ui.controlLink} data-testid="forms-clear-filters">
                  Clear filters
                </Link>
              ) : null}
            </>
          ) : (
            <>
          <Form key={location.search} method="get" style={ui.toolbar} data-testid="forms-filter">
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
            {filtered ? (
              <Link to={base} style={ui.controlLink} data-testid="forms-clear-filters">
                Clear filters
              </Link>
            ) : null}
            <a href={`${base}/export.csv${d.search ? `?${d.search}` : ''}`} style={{ ...ui.controlLink, color: '#1e3a8a', marginLeft: 'auto' }} data-testid="forms-csv">
              ↓ Export CSV
            </a>
          </Form>

          {state === 'error' ? null : (
            <p style={ui.muted} data-testid="forms-total" aria-live="polite">
              {loading
                ? 'Loading submissions…'
                : filtered
                  ? `${d.total} of ${received} ${received === 1 ? 'submission' : 'submissions'} match the filters`
                  : `${d.total} ${d.total === 1 ? 'submission' : 'submissions'}`}
            </p>
          )}

          {state === 'error' ? null : state === 'no-submissions' ? (
            <p style={ui.empty} data-testid="submissions-empty">
              No submissions yet. They appear here as soon as a visitor sends a form on the preview or the published app.
            </p>
          ) : state === 'no-match' ? (
            <p style={ui.empty} data-testid="submissions-no-match">
              No submission matches these filters.{' '}
              <Link to={base} style={ui.link} data-testid="submissions-no-match-clear">
                Clear filters
              </Link>{' '}
              to see all {received} {received === 1 ? 'submission' : 'submissions'}.
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
        </>
      )}
    </AppPage>
  );
}
