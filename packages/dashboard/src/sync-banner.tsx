/**
 * "A scheduled import stopped" — a self-contained banner any app
 * page can render (the app page, the Modules tab, the module's page). Feed it
 * what `loadSyncBanner()` (sync-banner.server.ts) returns; renders nothing
 * when no source is paused after failed runs.
 */
import { Link } from 'react-router';

export interface SyncBannerData {
  /** The sources paused after failed runs, with the error of the last run. */
  paused: { name: string; failures: number; error: string | null }[];
  /** The sync module's page, at its sources. */
  href: string;
}

const style = {
  box: {
    margin: '0.75rem 0 1rem',
    padding: '0.6rem 0.85rem',
    border: '1px solid #fecaca',
    background: '#fef2f2',
    color: '#7f1d1d',
    borderRadius: '10px',
    fontSize: '0.92rem',
  },
  list: { margin: '0.35rem 0 0.35rem 1.1rem', padding: 0 },
  link: { color: '#7f1d1d', fontWeight: 700 },
} as const;

export function SyncBanner({ banner, showLink = true }: { banner: SyncBannerData | null | undefined; showLink?: boolean }) {
  if (!banner || banner.paused.length === 0) return null;
  const n = banner.paused.length;
  return (
    <div role="alert" style={style.box} data-testid="sync-banner" data-count={n}>
      <strong>
        {n === 1 ? 'A scheduled import stopped' : `${n} scheduled imports stopped`} after failed runs
      </strong>{' '}
      — the app keeps showing the data of the last successful run.
      <ul style={style.list}>
        {banner.paused.map((s) => (
          <li key={s.name}>
            <code>{s.name}</code>: {s.failures} failed {s.failures === 1 ? 'run' : 'runs'} in a row
            {s.error ? <> — last error: {s.error}</> : null}
          </li>
        ))}
      </ul>
      Fix the cause (the upstream’s key, the source’s path or the collection’s schema), then resume the source or run it
      now.{' '}
      {showLink ? (
        <Link to={banner.href} style={style.link} data-testid="sync-banner-link">
          Open the sources →
        </Link>
      ) : null}
    </div>
  );
}
