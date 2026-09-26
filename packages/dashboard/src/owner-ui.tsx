/**
 * Client-safe building blocks of the owner's module tabs of an app (M2-03):
 * the shared inline styles (the dashboard's minimal look: system font, zinc
 * borders, one accent; form controls from the shared layout, NSO-342). The
 * pages render inside <AppPage> (breadcrumb, app header, tabs). No server
 * imports.
 */
import { controls, mergeStyles } from '@drobek/tenancy/layout';

export const ui = {
  /** The tab's own title under the app header. */
  title: { fontSize: '1.15rem', margin: '1.75rem 0 0.25rem' },
  h2: { fontSize: '1.1rem', margin: '2rem 0 0.5rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  muted: { color: '#8a8a8e' },
  empty: { color: '#555', fontStyle: 'italic', padding: '1rem 0' },
  toolbar: mergeStyles(controls.row, {
    margin: '1.25rem 0 0.75rem',
    padding: '0.75rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
    background: '#fafafa',
  }),
  field: controls.field,
  label: controls.label,
  input: controls.input,
  button: controls.button,
  /** A link on a control row (Clear, Export CSV). */
  controlLink: controls.link,
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

/**
 * Shown when no active module owns a tab's data (the authority — e.g. the
 * module that stores uploads). Named by what it does, not by a module name:
 * any module declaring the authority serves the tab (NSO-347).
 */
export function ModuleMissing({ does }: { does: string }) {
  return (
    <p style={ui.empty} data-testid="module-missing">
      No platform module on this server {does} (the operator lists modules in <code>DROBEK_MODULES</code>).
    </p>
  );
}
