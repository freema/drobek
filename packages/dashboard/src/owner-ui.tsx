/**
 * Client-safe building blocks of the owner's module tabs of an app (M2-03):
 * the tab strip between an app's Data / Forms / Users / Uploads / Logs pages
 * and the shared inline styles (the dashboard's minimal look: system font,
 * zinc borders, one accent). No server imports.
 */
import { Link } from 'react-router';
import { APP_TABS } from './app-tabs.js';

export type OwnerTab = 'data' | 'forms' | 'end-users' | 'uploads' | 'logs';

/** The strip mirrors the app page's data-driven tabs (NSO-288); the base page is linked separately. */
const TABS = APP_TABS.filter((t) => t.to !== '');

export const ui = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '60rem',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  nav: { margin: '0 0 1.25rem', fontSize: '0.9rem', display: 'flex', gap: '0.9rem', flexWrap: 'wrap', alignItems: 'baseline' },
  navLink: { color: '#1a1a1a', fontWeight: 600 },
  tabLink: { color: '#3f3f46', textDecoration: 'none', padding: '0.1rem 0.2rem' },
  tabActive: { color: '#1a1a1a', fontWeight: 700, textDecoration: 'none', borderBottom: '2px solid #1a1a1a', padding: '0.1rem 0.2rem' },
  h1: { fontSize: '1.6rem', margin: '0 0 0.25rem' },
  h2: { fontSize: '1.1rem', margin: '2rem 0 0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  muted: { color: '#8a8a8e' },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
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
  label: { fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#71717a', fontWeight: 700 },
  input: { fontFamily: 'inherit', fontSize: '0.85rem', padding: '0.3rem 0.45rem', border: '1px solid #d4d4d8', borderRadius: '6px' },
  button: {
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
  smallButton: {
    padding: '0.2rem 0.55rem',
    fontSize: '0.78rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  dangerButton: {
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
  link: { color: '#1e3a8a', fontSize: '0.85rem' },
  dangerLink: { color: '#b91c1c', fontSize: '0.8rem' },
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
  td: { borderBottom: '1px solid #f0f0f2', padding: '0.5rem 0.6rem 0.5rem 0', verticalAlign: 'top' },
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
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  badge: {
    display: 'inline-block',
    padding: '0.05rem 0.5rem',
    fontSize: '0.7rem',
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
    padding: '0.05rem 0.5rem',
    fontSize: '0.7rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#166534',
    background: '#dcfce7',
    border: '1px solid #bbf7d0',
  },
  badBadge: {
    display: 'inline-block',
    padding: '0.05rem 0.5rem',
    fontSize: '0.7rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    borderRadius: '999px',
    color: '#991b1b',
    background: '#fee2e2',
    border: '1px solid #fecaca',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  notice: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '1rem 0',
  },
  panel: { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.9rem 1rem', margin: '1rem 0', background: '#fcfcfd' },
  pager: { display: 'flex', gap: '1rem', margin: '1rem 0', fontSize: '0.88rem' },
} as const;

/** The strip of an app's module tabs (the current one highlighted), with a link back to the app. */
export function AppSubnav({ workspaceSlug, appSlug, current }: { workspaceSlug: string; appSlug: string; current: OwnerTab }) {
  const base = `/workspaces/${workspaceSlug}/apps/${appSlug}`;
  return (
    <nav style={ui.nav} aria-label="App sections" data-testid="app-subnav">
      <Link to={base} style={ui.navLink}>
        ← {appSlug}
      </Link>
      {TABS.map((t) => (
        <Link
          key={t.key}
          to={`${base}/${t.to}`}
          style={t.key === current ? ui.tabActive : ui.tabLink}
          aria-current={t.key === current ? 'page' : undefined}
          data-testid={`subnav-${t.key}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Shown when the module that owns a tab's data is not in DROBEK_MODULES. */
export function ModuleMissing({ module }: { module: string }) {
  return (
    <p style={ui.empty} data-testid="module-missing">
      The <code>{module}</code> platform module is not enabled on this server (the operator lists modules in <code>DROBEK_MODULES</code>).
    </p>
  );
}
