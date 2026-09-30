/**
 * The app page chrome every tab renders (<AppPage> puts it
 * inside the shared dashboard layout with the breadcrumb
 * `Workspaces › <workspace> › <app> › <section>`): the app's name + badges,
 * its preview / production URLs (links; the only place the dashboard frames
 * an app is the small sandboxed thumbnail of the workspace app list), the
 * compile state of the newest version, the single-writer lease banner with
 * "Unlock", the "Unpublish" control, the "taken down by the operator" banner,
 * the "publishing turned off / needs approval" notice, and the tab
 * bar (APP_TABS, data-driven).
 *
 * The header's forms post to the app's BASE route (`appAction`, which every
 * app-page route may share) with `redirectTo` = the current page, so any tab
 * — including ones added later — can render <AppHeader> without exporting
 * an action of its own. Controls render for editor+ only; the action
 * re-checks the role server-side.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Form, Link, useLocation, useNavigation } from 'react-router';
import { DashboardPage, TabStrip, controls, mergeStyles, tabStyles, workspaceCrumbs, type Crumb } from '@drobek/tenancy/layout';
import type { AppHeaderData } from './app-page.server.js';
import { APP_TABS, activeAppTab, appTabHref } from './app-tabs.js';
import { formatAgo } from './app-view.js';
import { LockedByAdminNotice } from './locked-notice.js';
import { PublishApprovalNotice } from './publish-approval-notice.js';

export const appStyles = {
  h1: { fontSize: 'clamp(1.35rem, 5vw, 1.75rem)', lineHeight: 1.25, margin: 0, minWidth: 0, overflowWrap: 'anywhere' },
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
  /** An app address on one line: a long one ends in "…" (the full address is its title and its target). */
  urlLink: { minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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

/**
 * The few rules inline styles cannot express (a media query). Below 40rem a
 * table marked `dk-cards` shows each row as a card: every cell with a
 * `data-label` gets that label above its value, and a row can place its
 * cells with `data-cell` grid areas (the version history does). The
 * stylesheet overrides the inline cell borders and paddings, hence
 * `!important`.
 */
const APP_PAGE_CSS = `@media (max-width: 40rem) {
.dk-cards, .dk-cards > tbody { display: block; width: 100%; }
.dk-cards > thead { display: none; }
.dk-cards > tbody > tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.45rem 0.9rem; border: 1px solid #e4e4e7; border-radius: 10px; padding: 0.7rem 0.85rem; margin-bottom: 0.6rem; background: #fcfcfd; }
.dk-cards > tbody > tr > td { display: block; min-width: 0; grid-column: 1 / -1; border: 0 !important; padding: 0 !important; overflow-wrap: anywhere; }
.dk-cards > tbody > tr > td[data-label]::before { content: attr(data-label); display: block; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #71717a; }
.dk-versions > tbody > tr { grid-template-areas: "version created" "by build" "note note" "actions actions"; }
.dk-versions > tbody > tr > td[data-cell="version"] { grid-area: version; }
.dk-versions > tbody > tr > td[data-cell="created"] { grid-area: created; }
.dk-versions > tbody > tr > td[data-cell="by"] { grid-area: by; }
.dk-versions > tbody > tr > td[data-cell="build"] { grid-area: build; }
.dk-versions > tbody > tr > td[data-cell="note"] { grid-area: note; }
.dk-versions > tbody > tr > td[data-cell="actions"] { grid-area: actions; }
.dk-versions td[data-cell="actions"] > span { flex-wrap: wrap !important; }
}`;

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
    <TabStrip label="App sections" testId="app-tabs" current={active}>
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
    </TabStrip>
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
      {header.duplicatedFrom ? (
        <p style={s.sub} data-testid="app-duplicated-from">
          Duplicated from {header.duplicatedFrom}
        </p>
      ) : null}
      {/* Taken down by the operator — on every tab. */}
      <LockedByAdminNotice locked={header.lockedByAdmin} />
      {/* This workspace may not publish (blocked, or not approved yet) — on every tab. */}
      {header.lockedByAdmin ? null : (
        <PublishApprovalNotice approval={header.publishApproval} canRequest={header.canEdit} action={header.basePath} busy={busy} />
      )}

      <div style={s.urlGrid}>
        <span style={s.label}>Production</span>
        <span style={s.inline}>
          {header.publishedVersion !== null ? (
            <>
              <a
                href={header.publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={header.publishedUrl}
                style={s.urlLink}
                data-testid="app-prod-url"
              >
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
              {header.publishApproval?.kind === 'blocked'
                ? 'not published — the operator turned publishing off for this workspace'
                : header.publishApproval
                  ? 'not published — publishing waits for the operator\'s approval'
                  : 'not published — publish a version on the Overview tab'}
            </span>
          )}
        </span>

        <span style={s.label}>Preview</span>
        <span style={s.inline}>
          <a
            href={header.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={header.previewUrl}
            style={s.urlLink}
            data-testid="app-preview-url"
          >
            {header.previewUrl}
          </a>
          {header.previewVersion !== null ? (
            <code style={s.mono}>v{header.previewVersion}</code>
          ) : (
            <span style={s.muted}>no successful build yet</span>
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
                <span style={s.okBadge}>build succeeded</span>
              ) : latest.compileStatus === 'error' ? (
                <span style={s.errBadge}>
                  {latest.errorCount} build error{latest.errorCount === 1 ? '' : 's'}
                </span>
              ) : (
                <span style={s.badge}>not built</span>
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
 * An app page: the shared layout, the breadcrumb
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
      <style>{APP_PAGE_CSS}</style>
      <AppHeader header={header} />
      {children}
    </DashboardPage>
  );
}

/** The failed action's message (`publish-error` for publish). */
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
