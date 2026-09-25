/**
 * The app page chrome every tab renders (NSO-288; NSO-342: <AppPage> puts it
 * inside the shared dashboard layout with the breadcrumb
 * `Workspaces › <workspace> › <app> › <section>`): the app's name + badges,
 * its preview / production URLs (links; the only place the dashboard frames
 * an app is the small sandboxed thumbnail of the workspace app list), the
 * compile state of the newest version, the single-writer lease banner with
 * "Unlock", the "Unpublish" control, the "taken down by the operator" banner
 * (NSO-293), and the tab bar (APP_TABS, data-driven).
 *
 * The header's forms post to the app's BASE route (`appAction`, which every
 * app-page route may share) with `redirectTo` = the current page, so any tab
 * — including ones added later — can render <AppHeader> without exporting
 * an action of its own. Controls render for editor+ only; the action
 * re-checks the role server-side.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import { DashboardPage, controls, mergeStyles, tabStyles, workspaceCrumbs, type Crumb } from '@drobek/tenancy/layout';
import type { AppHeaderData } from './app-page.server.js';
import { APP_TABS, activeAppTab, appTabHref } from './app-tabs.js';
import { formatAgo } from './app-view.js';
import { LockedByAdminNotice } from './locked-notice.js';

export const appStyles = {
  h1: { fontSize: '1.75rem', margin: 0 },
  h2: { fontSize: '1.15rem', marginTop: '2rem', marginBottom: '0.5rem' },
  headRow: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  sub: { color: '#71717a', fontSize: '0.9rem', margin: '0.15rem 0 0' },
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
  okBadge: {
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
  errBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#991b1b',
    background: '#fee2e2',
    border: '1px solid #fecaca',
  },
  urlGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    gap: '0.25rem 0.9rem',
    margin: '0.9rem 0 0',
    fontSize: '0.92rem',
    alignItems: 'center',
  },
  label: { color: '#71717a', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' },
  muted: { color: '#8a8a8e' },
  inline: { display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', minWidth: 0, overflowWrap: 'anywhere' },
  button: controls.button,
  secondaryButton: controls.secondaryButton,
  dangerButton: controls.dangerButton,
  lock: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexWrap: 'wrap',
    background: '#fffbeb',
    border: '1px solid #fde68a',
    color: '#78350f',
    borderRadius: '8px',
    padding: '0.55rem 0.8rem',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginTop: '1rem',
  },
  /** On a phone a wide table scrolls inside this box, never the page. */
  tableWrap: { overflowX: 'auto', maxWidth: '100%' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' },
  th: {
    textAlign: 'left',
    borderBottom: '1px solid #e4e4e7',
    padding: '0.45rem 0.5rem 0.45rem 0',
    color: '#555',
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  td: { borderBottom: '1px solid #f0f0f2', padding: '0.5rem 0.5rem 0.5rem 0', verticalAlign: 'top' },
  panel: {
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    background: '#fcfcfd',
    marginTop: '0.75rem',
  },
  input: mergeStyles(controls.input, { minWidth: 'min(16rem, 100%)' }),
} satisfies Record<string, CSSProperties>;

const s = appStyles;

/** A small POST form to the app's base action (hidden intent + redirectTo). */
function HeaderForm({
  base,
  intent,
  children,
}: {
  base: string;
  intent: string;
  children: ReactNode;
}) {
  const location = useLocation();
  return (
    <Form method="post" action={base} style={{ display: 'inline' }}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />
      {children}
    </Form>
  );
}

function AppTabs({ header }: { header: AppHeaderData }) {
  const location = useLocation();
  const active = activeAppTab(location.pathname, header.workspace.slug, header.slug);
  return (
    <nav style={tabStyles.bar} aria-label="App sections" data-testid="app-tabs">
      {APP_TABS.map((t) => (
        <Link
          key={t.key}
          to={appTabHref(header.workspace.slug, header.slug, t)}
          style={t.key === active ? tabStyles.active : tabStyles.tab}
          aria-current={t.key === active ? 'page' : undefined}
          data-testid="app-tab"
          data-tab={t.key}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function AppHeader({ header }: { header: AppHeaderData }) {
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const { latest, lock } = header;
  return (
    <header data-testid="app-header">
      <div style={s.headRow}>
        <h1 style={s.h1}>{header.name ?? header.slug}</h1>
        {header.publishedVersion !== null ? (
          <span style={s.okBadge}>published</span>
        ) : (
          <span style={s.badge}>not published</span>
        )}
        <span style={s.badge} data-testid="app-visibility">
          {header.visibility}
        </span>
      </div>
      {header.name && header.name !== header.slug ? <p style={s.sub}>{header.slug}</p> : null}
      {/* NSO-293: taken down by the operator — on every tab. */}
      <LockedByAdminNotice locked={header.lockedByAdmin} />

      <div style={s.urlGrid}>
        <span style={s.label}>Production</span>
        <span style={s.inline}>
          {header.publishedVersion !== null ? (
            <>
              <a href={header.publishedUrl} target="_blank" rel="noopener noreferrer" data-testid="app-prod-url">
                {header.publishedUrl}
              </a>
              <code style={s.mono} data-testid="app-published-version">
                v{header.publishedVersion}
              </code>
              {header.canEdit ? (
                <HeaderForm base={header.basePath} intent="unpublish">
                  <button type="submit" style={s.secondaryButton} disabled={busy} data-testid="unpublish-button">
                    Unpublish
                  </button>
                </HeaderForm>
              ) : null}
            </>
          ) : (
            <span style={s.muted} data-testid="app-published-version">
              not published — publish a version on the Overview tab
            </span>
          )}
        </span>

        <span style={s.label}>Preview</span>
        <span style={s.inline}>
          <a href={header.previewUrl} target="_blank" rel="noopener noreferrer" data-testid="app-preview-url">
            {header.previewUrl}
          </a>
          {header.previewVersion !== null ? (
            <code style={s.mono}>v{header.previewVersion}</code>
          ) : (
            <span style={s.muted}>nothing compiled yet</span>
          )}
        </span>

        <span style={s.label}>Latest</span>
        <span style={s.inline} data-testid="app-compile-status" data-status={latest?.compileStatus ?? 'none'}>
          {latest === null ? (
            <span style={s.muted}>no versions yet — your agent writes the first one</span>
          ) : (
            <>
              <code style={s.mono}>v{latest.number}</code>
              {latest.compileStatus === 'ok' ? (
                <span style={s.okBadge}>compiled</span>
              ) : latest.compileStatus === 'error' ? (
                <span style={s.errBadge}>
                  {latest.errorCount} compile error{latest.errorCount === 1 ? '' : 's'}
                </span>
              ) : (
                <span style={s.badge}>not compiled</span>
              )}
              {latest.compileStatus !== 'ok' && header.previewVersion !== null ? (
                <span style={s.muted}>the preview keeps serving v{header.previewVersion}</span>
              ) : null}
            </>
          )}
        </span>
      </div>

      {lock ? (
        <div style={s.lock} role="status" data-testid="app-lock">
          <span data-testid="app-lock-text">
            {lock.holderIsYou ? (
              <>Your agent</>
            ) : (
              <>
                An agent of <strong>{lock.holder}</strong>
              </>
            )}{' '}
            is working on this app
            {lock.secondsAgo !== null ? ` — last write ${formatAgo(lock.secondsAgo)}` : ''}. The lock expires on its own
            in {Math.max(1, Math.ceil(lock.expiresInSec / 60))} min.
          </span>
          {header.canEdit ? (
            <HeaderForm base={header.basePath} intent="unlock">
              <button type="submit" style={s.secondaryButton} disabled={busy} data-testid="unlock-button">
                Unlock
              </button>
            </HeaderForm>
          ) : null}
        </div>
      ) : null}

      <AppTabs header={header} />
    </header>
  );
}

/**
 * An app page (NSO-342): the shared layout, the breadcrumb
 * `Workspaces › <workspace> › <app> › <section> › …trail`, the app header with
 * its tabs, then the tab's content. The section is the active tab (none on
 * Overview); `trail` names what lies below it (a collection, a module).
 */
export function AppPage({
  header,
  trail = [],
  children,
}: {
  header: AppHeaderData;
  trail?: readonly Crumb[];
  children: ReactNode;
}) {
  const location = useLocation();
  const active = activeAppTab(location.pathname, header.workspace.slug, header.slug);
  const tab = APP_TABS.find((t) => t.key === active);
  const crumbs: Crumb[] = [...workspaceCrumbs(header.workspace), { label: header.slug, to: header.basePath }];
  if (tab && tab.to) crumbs.push({ label: tab.label, to: appTabHref(header.workspace.slug, header.slug, tab) });
  crumbs.push(...trail);
  return (
    <DashboardPage crumbs={crumbs}>
      <AppHeader header={header} />
      {children}
    </DashboardPage>
  );
}

/** The failed action's message (`publish-error` for publish, as before NSO-288). */
export function ActionError({ actionData }: { actionData?: { error?: string; intent?: string } | null }) {
  if (!actionData?.error) return null;
  return (
    <div
      style={s.error}
      role="alert"
      data-testid={actionData.intent === 'publish' ? 'publish-error' : 'action-error'}
      data-intent={actionData.intent}
    >
      {actionData.error}
    </div>
  );
}
