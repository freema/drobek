/**
 * The "drobek was updated to 0.8 · What's new" bar above every signed-in
 * dashboard page (rendered by the root layout from ./whats-new.server.ts).
 * "Dismiss" is a plain form post, so it works without JavaScript and the
 * whole page reloads without the bar.
 */
import { useLocation } from 'react-router';
import { PLATFORM_FONT, PLATFORM_RADIUS, platformColor } from '@drobek/core/platform-theme';

const styles = {
  bar: {
    fontFamily: PLATFORM_FONT,
    fontSize: '0.88rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: '0.4rem 0.9rem',
    padding: '0.5rem 1rem',
    background: platformColor('surface'),
    borderBottom: `1px solid ${platformColor('line')}`,
    boxShadow: `inset 3px 0 0 ${platformColor('crumb')}`,
    color: platformColor('ink'),
  },
  link: { color: platformColor('ink'), fontWeight: 600 },
  form: { margin: 0 },
  button: {
    font: 'inherit',
    fontSize: '0.82rem',
    padding: '0.15rem 0.6rem',
    border: `1px solid ${platformColor('line')}`,
    borderRadius: PLATFORM_RADIUS.sm,
    background: platformColor('bg'),
    color: platformColor('ink'),
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
