/**
 * /workspaces/:slug/apps — client half (U8, PHY-74 slice; filters NSO-288):
 * the workspace's apps with name / status / visibility / published state /
 * latest version, a search + published filter + sort (a plain GET form, so
 * the filtered list is a shareable URL). Each app links to its page. Server
 * code lives in ./workspaces.$slug.apps.server.ts.
 *
 * NSO-342: the workspace's landing page inside the shared workspace layout,
 * and every app has a small THUMBNAIL — its published (else preview) host in
 * a scaled-down iframe that is sandboxed (`allow-scripts allow-same-origin`
 * only: the app keeps its own origin, which is never the dashboard's, and can
 * neither navigate this page, open windows, submit forms nor show dialogs),
 * `credentialless` where the browser supports it, lazily loaded, sent no
 * referrer, and inert (no pointer events, no focus, hidden from assistive
 * tech). The app hosts allow exactly the dashboard origin in frame-ancestors.
 * A password-gated, taken-down, inactive or never-compiled app shows a
 * placeholder (its initial) instead. See docs/SECURITY.md.
 */
import type { IframeHTMLAttributes } from 'react';
import { Form, Link, useLoaderData } from 'react-router';
import { WorkspacePage, controls } from '@drobek/tenancy/layout';
import type { loader } from './workspaces.$slug.apps.server.js';
import { formatTimestamp, type AppThumbnail } from '../view.js';

export function meta({
  data,
}: {
  data?: Awaited<ReturnType<typeof loader>>;
}) {
  return [{ title: `Apps — ${data?.workspace.name ?? 'Workspace'} — drobek` }];
}

/** The iframe renders the app at this size and scales it down into the tile. */
const FRAME_W = 1280;
const FRAME_H = 800;
const THUMB_W = 128;
const THUMB_H = (THUMB_W * FRAME_H) / FRAME_W;

const PLACEHOLDER_TEXT: Record<Exclude<AppThumbnail, { kind: 'frame' }>['reason'], string> = {
  password: 'password protected',
  'taken-down': 'taken down',
  inactive: 'not live',
  'nothing-compiled': 'nothing compiled yet',
};

const styles = {
  list: { listStyle: 'none', padding: 0, margin: '1.25rem 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.9rem',
    padding: '0.6rem 0.75rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    marginBottom: '0.6rem',
  },
  body: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem 0.6rem', minWidth: 0, flex: '1 1 auto' },
  thumb: {
    position: 'relative',
    flex: 'none',
    display: 'block',
    width: `${THUMB_W}px`,
    height: `${THUMB_H}px`,
    overflow: 'hidden',
    borderRadius: '6px',
    border: '1px solid #e4e4e7',
    background: '#fafafa',
    color: 'inherit',
    textDecoration: 'none',
  },
  frame: {
    width: `${FRAME_W}px`,
    height: `${FRAME_H}px`,
    border: 0,
    transform: `scale(${THUMB_W / FRAME_W})`,
    transformOrigin: '0 0',
    pointerEvents: 'none',
    background: '#fff',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#a1a1aa',
    textAlign: 'center',
    lineHeight: 1.1,
  },
  initial: { fontSize: '1.6rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase' },
  why: { fontSize: '0.62rem', marginTop: '0.2rem' },
  appLink: { fontWeight: 600, color: '#1a1a1a', textDecoration: 'none', overflowWrap: 'anywhere' },
  meta: { color: '#8a8a8e', fontSize: '0.85rem' },
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
  liveBadge: {
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
  hibBadge: {
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
  empty: {
    color: '#555',
    fontStyle: 'italic',
    padding: '1rem 0',
  },
  filters: { ...controls.row, alignItems: 'center', margin: '1rem 0 0' },
  search: { ...controls.input, flex: '1 1 14rem', minWidth: 0, maxWidth: '22rem' },
  notice: {
    background: '#f4f4f5',
    border: '1px solid #e4e4e7',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  name: { color: '#8a8a8e', fontSize: '0.85rem' },
} as const;

/**
 * `credentialless` (Chromium): the frame gets a fresh, throwaway cookie +
 * storage partition — the thumbnail never runs as the viewer's session on the
 * app. React has no typed prop for it; other browsers ignore it.
 */
const CREDENTIALLESS = { credentialless: '' } as IframeHTMLAttributes<HTMLIFrameElement>;

function Thumbnail({ slug, thumbnail, to }: { slug: string; thumbnail: AppThumbnail; to: string }) {
  return (
    <Link
      to={to}
      style={styles.thumb}
      tabIndex={-1}
      aria-hidden="true"
      data-testid="app-thumb"
      data-thumb={thumbnail.kind}
      data-reason={thumbnail.kind === 'placeholder' ? thumbnail.reason : undefined}
    >
      {thumbnail.kind === 'frame' ? (
        <iframe
          src={thumbnail.url}
          title={`Preview of ${slug}`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          scrolling="no"
          tabIndex={-1}
          aria-hidden="true"
          inert
          style={styles.frame}
          data-testid="app-thumb-frame"
          {...CREDENTIALLESS}
        />
      ) : (
        <span style={styles.placeholder} title={PLACEHOLDER_TEXT[thumbnail.reason]}>
          <span style={styles.initial}>{slug.slice(0, 1)}</span>
          <span style={styles.why}>{PLACEHOLDER_TEXT[thumbnail.reason]}</span>
        </span>
      )}
    </Link>
  );
}

export default function WorkspaceAppsRoute() {
  const { nav, workspace, apps, total, filters, deletedSlug, slugReleaseDays } = useLoaderData<typeof loader>();
  const filtered = filters.q !== '' || filters.status !== 'all';

  return (
    <WorkspacePage workspace={nav} section="apps">
      {deletedSlug ? (
        <p style={styles.notice} role="status" data-testid="apps-deleted-notice">
          <strong>{deletedSlug}</strong> was deleted. Its address stays reserved for {slugReleaseDays} days.
        </p>
      ) : null}

      {total > 0 ? (
        <Form method="get" style={styles.filters} data-testid="apps-filters">
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Search name or address"
            aria-label="Search apps"
            style={styles.search}
            data-testid="apps-filter-q"
          />
          <select
            name="status"
            defaultValue={filters.status}
            aria-label="Published state"
            style={controls.select}
            data-testid="apps-filter-status"
          >
            <option value="all">All apps</option>
            <option value="published">Published</option>
            <option value="unpublished">Not published</option>
          </select>
          <select name="sort" defaultValue={filters.sort} aria-label="Sort" style={controls.select} data-testid="apps-filter-sort">
            <option value="updated">Recently changed</option>
            <option value="created">Newest</option>
            <option value="name">Name</option>
          </select>
          <button type="submit" style={controls.button} data-testid="apps-filter-apply">
            Filter
          </button>
          {filtered ? (
            <span style={styles.meta} data-testid="apps-filter-count">
              {apps.length} of {total}
            </span>
          ) : null}
        </Form>
      ) : null}

      {total === 0 ? (
        <p style={styles.empty} data-testid="apps-empty">
          No apps yet — ask your agent to create one with the drobek MCP tools.
        </p>
      ) : apps.length === 0 ? (
        <p style={styles.empty} data-testid="apps-no-match">
          No app matches the filter.
        </p>
      ) : (
        <ul style={styles.list} data-testid="apps-list">
          {apps.map((app) => {
            const to = `/workspaces/${workspace.slug}/apps/${app.slug}`;
            return (
              <li key={app.slug} style={styles.item} data-testid="app-row" data-app-slug={app.slug}>
                <Thumbnail slug={app.slug} thumbnail={app.thumbnail} to={to} />
                <div style={styles.body}>
                  <Link to={to} style={styles.appLink} data-testid="app-detail-link">
                    {app.slug}
                  </Link>
                  {app.name && app.name !== app.slug ? <span style={styles.name}>{app.name}</span> : null}
                  {app.published ? (
                    <span style={styles.liveBadge}>published</span>
                  ) : (
                    <span style={styles.badge}>not published</span>
                  )}
                  {app.status === 'hibernated' ? <span style={styles.hibBadge}>hibernated</span> : null}
                  <span style={styles.badge}>{app.visibility}</span>
                  {app.latestVersion !== null && app.lastChangeAt ? (
                    <span style={styles.meta} data-testid="app-latest-version">
                      v{app.latestVersion} · {formatTimestamp(app.lastChangeAt)}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </WorkspacePage>
  );
}
