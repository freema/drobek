/**
 * /workspaces/:slug/apps/:appSlug/feedback — client half of the Feedback
 * tab: the notes members left on the preview, filtered open / resolved / all,
 * each with its author, version, page and spot, a link that opens the preview
 * there, Resolve (with an optional note) / Reopen for editors, and Delete for
 * the author and workspace admins. Note texts are member input: React
 * escapes them.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.feedback.server.js';
import { ui } from '../owner-ui.js';
import { AppPage } from '../app-header.js';
import { feedbackListState } from '../feedback-view.js';
import { formatTimestamp } from '../view.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Feedback — ${data?.appSlug ?? 'App'} — drobek` }];
}

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
] as const;

const card = { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.8rem 0.95rem', margin: '0.75rem 0', background: '#fff' } as const;
const body = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0.4rem 0', fontSize: '0.95rem' } as const;
const meta2 = { color: '#555', fontSize: '0.8rem', margin: 0 } as const;
const actions = { display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' } as const;

export default function AppFeedbackRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const base = `/workspaces/${d.workspace.slug}/apps/${d.appSlug}/feedback`;
  const statusSearch = d.status === 'open' ? '' : `?status=${d.status}`;
  const state = feedbackListState({ filter: d.status, rows: d.rows.length, open: d.counts.open, resolved: d.counts.resolved, error: d.error });
  const loading = navigation.state === 'loading' && navigation.location?.pathname === base;
  const busy = navigation.state === 'submitting';

  return (
    <AppPage header={d.header}>
      <h2 style={ui.title}>Feedback</h2>
      <p style={ui.hint}>
        Notes people in this workspace left on <strong>{d.appSlug}</strong>&apos;s preview with its Feedback button, pinned to the version,
        page and spot they saw. Your coding agent reads them with <code>list_feedback</code> and marks them resolved once they are fixed.
      </p>

      {actionData && 'error' in actionData ? (
        <div style={ui.error} role="alert" data-testid="feedback-action-error">
          {actionData.error}
        </div>
      ) : null}

      <nav style={ui.toolbar} aria-label="Filter notes" data-testid="feedback-filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            to={`${base}${f.key === 'open' ? '' : `?status=${f.key}`}`}
            style={{ ...ui.controlLink, fontWeight: d.status === f.key ? 700 : 400, textDecoration: d.status === f.key ? 'underline' : 'none' }}
            aria-current={d.status === f.key ? 'page' : undefined}
            data-testid={`feedback-filter-${f.key}`}
          >
            {f.label} ({f.key === 'open' ? d.counts.open : f.key === 'resolved' ? d.counts.resolved : d.counts.open + d.counts.resolved})
          </Link>
        ))}
        <a href={d.previewUrl} target="_blank" rel="noopener noreferrer" style={{ ...ui.controlLink, color: '#1e3a8a', marginLeft: 'auto' }}>
          Open the preview ↗
        </a>
      </nav>

      {loading ? (
        <p style={ui.muted} aria-live="polite">
          Loading notes…
        </p>
      ) : null}

      {state === 'error' ? (
        <div style={ui.error} role="alert" data-testid="feedback-error">
          {d.error}{' '}
          <Link to={`${base}${statusSearch}`} style={ui.link}>
            Show the newest notes
          </Link>
        </div>
      ) : state === 'none' ? (
        <p style={ui.empty} data-testid="feedback-none">
          No feedback yet. Open the preview, click <strong>Feedback</strong> in its bottom-right corner, pick the spot your note is about
          and write it in the window that opens — every member of this workspace can, viewers included. Notes appear here.
        </p>
      ) : state === 'all-resolved' ? (
        <p style={ui.empty} data-testid="feedback-all-resolved">
          No open notes — all {d.counts.resolved} {d.counts.resolved === 1 ? 'note is' : 'notes are'} resolved.{' '}
          <Link to={`${base}?status=resolved`} style={ui.link}>
            Show the resolved notes
          </Link>
          .
        </p>
      ) : state === 'none-resolved' ? (
        <p style={ui.empty} data-testid="feedback-none-resolved">
          No note is resolved yet. Once an editor or their agent resolves an open note, it moves here.
        </p>
      ) : (
        <div data-testid="feedback-list">
          {d.rows.map((r) => (
            <article key={r.id} style={card} data-testid="feedback-row" data-feedback-id={r.id} data-status={r.status}>
              <p style={meta2}>
                {r.status === 'resolved' ? <span style={ui.okBadge}>resolved</span> : <span style={ui.badge}>open</span>}{' '}
                {r.author ?? 'A former member'} · {formatTimestamp(r.createdAt)} · {r.version !== null ? `version ${r.version}` : 'preview'} ·{' '}
                <code style={ui.mono}>{r.path}</code>
              </p>
              <p style={body} data-testid="feedback-body">
                {r.body}
              </p>
              <p style={meta2}>Spot: {r.spot}</p>
              {r.status === 'resolved' ? (
                <p style={{ ...meta2, marginTop: '0.35rem' }} data-testid="feedback-resolution">
                  Resolved {formatTimestamp(r.resolvedAt)}
                  {r.resolvedBy ? ` by ${r.resolvedBy}` : ''}
                  {r.resolvedByAgent ? ' (their agent)' : ''}
                  {r.resolutionNote ? `: ${r.resolutionNote}` : '.'}
                </p>
              ) : null}
              <div style={actions}>
                <a href={r.openUrl} target="_blank" rel="noopener noreferrer" style={ui.link} data-testid="feedback-open">
                  Open {r.version !== null ? `version ${r.version}` : 'the preview'} at this page ↗
                </a>
                {d.canResolve ? (
                  r.status === 'open' ? (
                    <Form method="post" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input type="hidden" name="intent" value="resolve" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={d.status} />
                      <input
                        name="note"
                        maxLength={d.noteMax}
                        placeholder="What changed (optional)"
                        style={{ ...ui.input, minWidth: '14rem' }}
                        aria-label="Resolution note"
                      />
                      <button type="submit" style={ui.smallButton} disabled={busy} data-testid="feedback-resolve">
                        Resolve
                      </button>
                    </Form>
                  ) : (
                    <Form method="post" style={{ display: 'inline' }}>
                      <input type="hidden" name="intent" value="reopen" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={d.status} />
                      <button type="submit" style={ui.smallButton} disabled={busy} data-testid="feedback-reopen">
                        Reopen
                      </button>
                    </Form>
                  )
                ) : null}
                {r.canDelete ? (
                  d.confirmId === r.id ? (
                    <Form method="post" style={{ display: 'inline' }}>
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={d.status} />
                      <button type="submit" style={ui.dangerButton} disabled={busy} data-testid="feedback-delete-confirm">
                        Delete for good
                      </button>{' '}
                      <Link to={`${base}${statusSearch}`} style={ui.link}>
                        Cancel
                      </Link>
                    </Form>
                  ) : (
                    <Link
                      to={`${base}?${new URLSearchParams({ ...(d.status === 'open' ? {} : { status: d.status }), confirm: r.id }).toString()}`}
                      style={ui.dangerLink}
                      data-testid="feedback-delete"
                    >
                      Delete
                    </Link>
                  )
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <div style={ui.pager}>
        {d.paged ? <Link to={`${base}${statusSearch}`}>« Newest notes</Link> : null}
        {d.nextBefore ? (
          <Link to={`${base}${d.nextBefore}`} data-testid="feedback-next">
            Older notes »
          </Link>
        ) : null}
      </div>
    </AppPage>
  );
}
