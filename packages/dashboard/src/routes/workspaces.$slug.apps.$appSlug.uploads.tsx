/**
 * /workspaces/:slug/apps/:appSlug/uploads — client half of the Uploads tab
 * (M2-03): the files the app's end users uploaded (the files module), usage
 * against the quota, an inline preview for raster images (served by the
 * dashboard with nosniff), a download link, and (editor+) delete behind a
 * confirm step.
 */
import { Form, Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.uploads.server.js';
import { ModuleMissing, ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Uploads — ${data?.appSlug ?? 'App'} — drobek` }];
}

const thumb = { maxWidth: '96px', maxHeight: '72px', borderRadius: '6px', border: '1px solid #e4e4e7', display: 'block' } as const;

export default function AppUploadsRoute() {
  const d = useLoaderData<typeof loader>();
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/uploads`;

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Uploads</h2>
      <p style={ui.hint}>
        Files the users of <strong>{d.appSlug}</strong> uploaded (the files module). Types are decided from the bytes.
      </p>

      {!d.enabled ? (
        <ModuleMissing does="stores end-user uploads" />
      ) : (
        <>
          {d.error ? (
            <div style={ui.error} role="alert" data-testid="uploads-error">
              {d.error}
            </div>
          ) : null}
          <p style={ui.muted} data-testid="uploads-usage">
            {d.used} of {d.quota} used
          </p>

          {d.files.length === 0 ? (
            <p style={ui.empty} data-testid="uploads-empty">
              No uploads yet.
            </p>
          ) : (
            <div style={ui.tableWrap}>
              <table style={ui.table} data-testid="uploads-table">
                <thead>
                  <tr>
                    <th style={ui.th}>Preview</th>
                    <th style={ui.th}>Name</th>
                    <th style={ui.th}>Type</th>
                    <th style={ui.th}>Size</th>
                    <th style={ui.th}>Uploaded by</th>
                    <th style={ui.th}>When</th>
                    <th style={ui.th} />
                  </tr>
                </thead>
                <tbody>
                  {d.files.map((f) => (
                    <tr key={f.id} data-testid="upload-row" data-file-id={f.id}>
                      <td style={ui.td}>
                        {f.previewable ? (
                          <img src={`${base}/${f.id}`} alt={f.name || f.id} style={thumb} loading="lazy" data-testid="upload-preview" />
                        ) : (
                          <span style={ui.muted}>—</span>
                        )}
                      </td>
                      <td style={ui.td}>
                        {f.name || <span style={ui.muted}>(no name)</span>}
                        <div style={{ ...ui.muted, ...ui.mono }}>{f.id}</div>
                      </td>
                      <td style={ui.td}>
                        <code style={ui.mono}>{f.type}</code>
                      </td>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{f.sizeText}</td>
                      <td style={ui.td}>{f.owner ? <code style={ui.mono}>{f.owner}</code> : <span style={ui.muted}>visitor</span>}</td>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>{formatTimestamp(f.created_at)}</td>
                      <td style={{ ...ui.td, whiteSpace: 'nowrap' }}>
                        <a href={`${base}/${f.id}?download=1`} style={ui.link} data-testid="upload-download">
                          Download
                        </a>{' '}
                        {d.canDelete ? (
                          d.confirmId === f.id ? (
                            <Form method="post" style={{ display: 'inline' }} data-testid="upload-delete-form">
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="id" value={f.id} />
                              <button type="submit" style={ui.dangerButton} data-testid="upload-delete-confirm">
                                Confirm delete
                              </button>{' '}
                              <Link to={base} style={ui.link}>
                                Cancel
                              </Link>
                            </Form>
                          ) : (
                            <Link to={`${base}?confirm=${f.id}`} style={ui.dangerLink} data-testid="upload-delete">
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
                <Link to={base}>« First page</Link>
                <Link to={`${base}?cursor=${encodeURIComponent(d.nextCursor)}`} data-testid="uploads-next">
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
