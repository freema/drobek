/**
 * The dashboard footer (M2-04, NSO-284; NSO-342): `drobek <version> · <sha> ·
 * Source (AGPL-3.0) · ★ <stars>`. "Source" is the AGPL-3.0 §13 link to the
 * exact commit of the running build; the stars link the repository and are
 * left out while the count is unknown (see ./github-stars.server.ts).
 * Rendered by the root layout on every dashboard page; client-safe (the
 * values come from the root loader, see ./source-link.ts).
 */
import { SOURCE_REPO_URL, sourceLink } from './source-link.js';

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
  mono: { fontFamily: 'ui-monospace, monospace' },
} as const;

const SEP = ' · ';

export function SourceFooter({
  sha,
  version,
  stars,
}: {
  sha: string | null | undefined;
  /** The release (`DROBEK_VERSION`, e.g. `v0.1.2`), `dev` outside a release build. */
  version?: string | null;
  /** The repository's GitHub stars; null/absent → not shown. */
  stars?: number | null;
}) {
  const link = sourceLink(sha);
  return (
    <footer style={styles.footer} data-testid="source-footer">
      <span data-testid="footer-version">drobek {version || 'dev'}</span>
      {link.sha ? (
        <>
          {SEP}
          <code style={styles.mono} data-testid="footer-sha">
            {link.sha}
          </code>
        </>
      ) : null}
      {SEP}
      <a
        href={link.href}
        style={styles.link}
        rel="noopener noreferrer license"
        data-testid="source-link"
        data-sha={link.sha ?? ''}
      >
        Source (AGPL-3.0)
      </a>
      {typeof stars === 'number' ? (
        <>
          {SEP}
          <a
            href={SOURCE_REPO_URL}
            style={styles.link}
            rel="noopener noreferrer"
            aria-label={`${stars} stars on GitHub`}
            data-testid="footer-stars"
          >
            ★ {stars.toLocaleString('en-US')}
          </a>
        </>
      ) : null}
    </footer>
  );
}
