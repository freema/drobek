/**
 * The shared dashboard page layout (NSO-342) — client-safe, no server
 * imports. Every signed-in dashboard page renders its content inside
 * <DashboardPage>: one max width, one padding, and a breadcrumb
 * (`Workspaces › <workspace> › <app> › <section>`, every part a link except
 * the current one) in place of per-page "← back" links. Workspace-level pages
 * use <WorkspacePage> (the workspace name + badges and the workspace tabs);
 * the app pages build on it in @drobek/dashboard (AppPage).
 *
 * It also holds the one set of form-control styles (`controls`): inputs,
 * selects, buttons and link-buttons share a height, border and radius, so a
 * filter row lines up on one line. Plain inline styles, the dashboard's
 * minimal look (system font, zinc borders, one dark accent).
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { DrobekMark } from '@drobek/auth/mark';
import type { WorkspaceNav } from './workspace-nav.js';

/** The content width of every dashboard page. */
export const PAGE_MAX_WIDTH = '60rem';

const CONTROL_HEIGHT = '2.125rem';

const control: CSSProperties = {
  boxSizing: 'border-box',
  height: CONTROL_HEIGHT,
  padding: '0 0.6rem',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  lineHeight: 1.2,
  color: '#1a1a1a',
  background: '#fff',
  border: '1px solid #d4d4d8',
  borderRadius: '7px',
  verticalAlign: 'middle',
};

const buttonBase: CSSProperties = {
  ...control,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.35rem',
  padding: '0 0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  textDecoration: 'none',
};

/**
 * Merge styles into one CSSProperties (e.g. a control plus a width) — keeps
 * the exported style objects' declared types portable (a spread would infer
 * csstype's internal names).
 */
export function mergeStyles(...parts: CSSProperties[]): CSSProperties {
  return Object.assign({}, ...parts) as CSSProperties;
}

type ControlStyle = 'input' | 'select' | 'button' | 'secondaryButton' | 'dangerButton' | 'link' | 'row' | 'field' | 'label';

/** One height, border and radius for every form control of the dashboard. */
export const controls: Readonly<Record<ControlStyle, CSSProperties>> = {
  input: control,
  select: { ...control, paddingRight: '0.3rem' },
  button: { ...buttonBase, color: '#fff', background: '#1a1a1a', border: '1px solid #1a1a1a' },
  secondaryButton: buttonBase,
  dangerButton: { ...buttonBase, color: '#fff', background: '#b91c1c', border: '1px solid #b91c1c' },
  /** A plain link that sits on a control row (same height → same baseline). */
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    height: CONTROL_HEIGHT,
    fontSize: '0.875rem',
    color: '#52525b',
    whiteSpace: 'nowrap',
  },
  /** A row of controls: bottoms aligned, wraps on narrow screens. */
  row: { display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' },
  /** A labelled control inside a row (label above). */
  field: { display: 'flex', flexDirection: 'column', gap: '0.2rem', minWidth: 0 },
  label: {
    fontSize: '0.68rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#71717a',
    fontWeight: 700,
  },
};

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: PAGE_MAX_WIDTH,
    margin: '0 auto',
    padding: '2rem 1.25rem 3rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  crumbNav: { display: 'flex', alignItems: 'center', gap: '0.7rem', margin: '0 0 1.5rem' },
  markLink: { display: 'block', flex: 'none' },
  crumbs: {
    listStyle: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '0.15rem 0.45rem',
    margin: 0,
    padding: 0,
    fontSize: '0.88rem',
    color: '#71717a',
  },
  crumb: { display: 'inline-flex', gap: '0.45rem', minWidth: 0, overflowWrap: 'anywhere' },
  crumbLink: { color: '#52525b', textDecoration: 'none' },
  crumbCurrent: { color: '#1a1a1a', fontWeight: 600 },
  sep: { color: '#a1a1aa' },
  headRow: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' },
  h1: { fontSize: '1.75rem', margin: 0, lineHeight: 1.25, overflowWrap: 'anywhere' },
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
  roleBadge: {
    display: 'inline-block',
    padding: '0.1rem 0.55rem',
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#1e3a8a',
    background: '#dbeafe',
    border: '1px solid #bfdbfe',
  },
} satisfies Record<string, CSSProperties>;

/** The tab bar look shared by the workspace tabs and the app tabs. */
export const tabStyles = {
  bar: {
    display: 'flex',
    gap: '0.25rem',
    borderBottom: '1px solid #e4e4e7',
    margin: '1.5rem 0 0',
    flexWrap: 'wrap',
  },
  tab: {
    padding: '0.45rem 0.85rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#52525b',
    textDecoration: 'none',
    borderBottom: '2px solid transparent',
    marginBottom: '-1px',
  },
  active: {
    padding: '0.45rem 0.85rem',
    fontSize: '0.9rem',
    fontWeight: 700,
    color: '#1a1a1a',
    textDecoration: 'none',
    borderBottom: '2px solid #1a1a1a',
    marginBottom: '-1px',
  },
} satisfies Record<string, CSSProperties>;

export interface Crumb {
  label: string;
  /** Omitted for the current page (the last crumb is never a link). */
  to?: string;
}

/** The mascot (home) then `Workspaces › …` — every part a link except the last. */
export function Breadcrumb({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb" style={styles.crumbNav}>
      <Link to="/workspaces" aria-label="drobek — workspaces" style={styles.markLink}>
        <DrobekMark size={24} />
      </Link>
      <ol style={styles.crumbs}>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${i}-${c.label}`} style={styles.crumb} data-testid="breadcrumb-item">
              {i > 0 ? (
                <span aria-hidden="true" style={styles.sep}>
                  ›
                </span>
              ) : null}
              {last || !c.to ? (
                <span style={last ? styles.crumbCurrent : undefined} aria-current={last ? 'page' : undefined}>
                  {c.label}
                </span>
              ) : (
                <Link to={c.to} style={styles.crumbLink}>
                  {c.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The page frame of every signed-in dashboard page: max width + breadcrumb. */
export function DashboardPage({ crumbs, children }: { crumbs?: readonly Crumb[]; children: ReactNode }) {
  return (
    <main style={styles.main}>
      {crumbs && crumbs.length > 0 ? <Breadcrumb items={crumbs} /> : null}
      {children}
    </main>
  );
}

export type WorkspaceSection = 'apps' | 'members' | 'activity' | 'upstreams' | 'modules';

/** The workspace's landing page — its apps (the breadcrumb's workspace link). */
export function workspaceHref(slug: string): string {
  return `/workspaces/${slug}/apps`;
}

/** `Workspaces › <workspace>` — the start of every workspace and app breadcrumb. */
export function workspaceCrumbs(workspace: { slug: string; name: string }): Crumb[] {
  return [
    { label: 'Workspaces', to: '/workspaces' },
    { label: workspace.name, to: workspaceHref(workspace.slug) },
  ];
}

const SECTIONS: readonly { key: WorkspaceSection; label: string; path: string }[] = [
  { key: 'apps', label: 'Apps', path: 'apps' },
  { key: 'members', label: 'Members', path: '' },
  { key: 'activity', label: 'Activity', path: 'activity' },
  { key: 'upstreams', label: 'Upstreams', path: 'upstreams' },
  // NSO-347: the server's platform modules, read-only for every member.
  { key: 'modules', label: 'Modules', path: 'modules' },
];

function sectionHref(slug: string, path: string): string {
  return path ? `/workspaces/${slug}/${path}` : `/workspaces/${slug}`;
}

/**
 * A workspace-level page: breadcrumb, the workspace name + kind + your role,
 * the workspace tabs (Activity and Upstreams only for workspace admins, the
 * server gates them too), then the page.
 */
export function WorkspacePage({
  workspace,
  section,
  trail = [],
  children,
}: {
  workspace: WorkspaceNav;
  section: WorkspaceSection;
  /** Crumbs below the section (e.g. an invite). */
  trail?: readonly Crumb[];
  children: ReactNode;
}) {
  const current = SECTIONS.find((s) => s.key === section)!;
  const crumbs: Crumb[] = [...workspaceCrumbs(workspace)];
  if (section !== 'apps') crumbs.push({ label: current.label, to: sectionHref(workspace.slug, current.path) });
  crumbs.push(...trail);
  const tabs = SECTIONS.filter(
    (s) => (s.key !== 'activity' || workspace.canViewActivity) && (s.key !== 'upstreams' || workspace.canManageUpstreams)
  );
  return (
    <DashboardPage crumbs={crumbs}>
      <header data-testid="workspace-header">
        <div style={styles.headRow}>
          <h1 style={styles.h1}>{workspace.name}</h1>
          <span style={styles.badge}>{workspace.kind}</span>
          <span style={styles.roleBadge} data-testid="my-role">
            {workspace.role}
          </span>
        </div>
        <nav style={tabStyles.bar} aria-label="Workspace sections" data-testid="workspace-tabs">
          {tabs.map((t) => (
            <Link
              key={t.key}
              to={sectionHref(workspace.slug, t.path)}
              style={t.key === section ? tabStyles.active : tabStyles.tab}
              aria-current={t.key === section ? 'page' : undefined}
              data-testid="workspace-tab"
              data-tab={t.key}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </DashboardPage>
  );
}
