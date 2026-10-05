/**
 * The "drobek was updated to 0.8 · What's new" bar above every signed-in
 * dashboard page (rendered by the root layout from ./whats-new.server.ts).
 * "Dismiss" is a plain form post, so it works without JavaScript and the
 * whole page reloads without the bar.
 */
import { useLocation } from 'react-router';

const styles = {
  bar: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '0.88rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: '0.4rem 0.9rem',
    padding: '0.5rem 1rem',
    background: '#eff6ff',
    borderBottom: '1px solid #bfdbfe',
    color: '#1e3a8a',
  },
  link: { color: '#1d4ed8', fontWeight: 600 },
  form: { margin: 0 },
  button: {
    font: 'inherit',
    fontSize: '0.82rem',
    padding: '0.15rem 0.6rem',
    border: '1px solid #93c5fd',
    borderRadius: '6px',
    background: '#fff',
    color: '#1e3a8a',
    cursor: 'pointer',
  },
} as const;

export function WhatsNewBanner({ line }: { line: string }) {
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  return (
    <div role="status" style={styles.bar} data-testid="whats-new-banner" data-line={line}>
      <span>
        drobek was updated to {line}
        {' · '}
        <a href="/whats-new" style={styles.link} target="_blank" rel="noopener noreferrer">
          What&apos;s new
        </a>
      </span>
      <form method="post" action="/whats-new/dismiss" style={styles.form}>
        <input type="hidden" name="redirectTo" value={here} />
        <button type="submit" style={styles.button} title="Hide this notice until drobek is updated to a newer version">
          Dismiss
        </button>
      </form>
    </div>
  );
}
