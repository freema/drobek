/**
 * The dashboard footer (M2-04, NSO-284): the AGPL-3.0 §13 source link to the
 * running commit. Rendered by the root layout on every dashboard page;
 * client-safe (the sha comes from the root loader, see ./source-link.ts).
 */
import { sourceLink } from './source-link.js';

/** The repository URL, for pages that link the source outside the footer (the apex landing). */
export { SOURCE_REPO_URL } from './source-link.js';

const styles = {
  footer: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '0.78rem',
    color: '#71717a',
    textAlign: 'center',
    padding: '2rem 1rem 1.5rem',
  },
  link: { color: '#71717a' },
} as const;

export function SourceFooter({ sha }: { sha: string | null | undefined }) {
  const link = sourceLink(sha);
  return (
    <footer style={styles.footer} data-testid="source-footer">
      <a
        href={link.href}
        style={styles.link}
        rel="noopener noreferrer license"
        data-testid="source-link"
        data-sha={link.sha ?? ''}
      >
        {link.label}
      </a>
    </footer>
  );
}
