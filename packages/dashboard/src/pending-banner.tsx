/**
 * "N changes await confirmation" (M2-02, NSO-291) — a self-contained banner
 * any app page can render (the app header, the Modules tab). Feed it the
 * shape `loadPendingBanner()` (pending-banner.server.ts) returns; renders
 * nothing when nothing waits.
 */
import { Link } from 'react-router';

export interface PendingBannerData {
  /** Pending changes (confirmRequired strings) across the app's modules. */
  count: number;
  /** The modules with a pending change. */
  modules: string[];
  /** Where to review them: the module's page when there is one, else the Modules tab. */
  href: string;
}

const style = {
  box: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap',
    margin: '0.75rem 0 1rem',
    padding: '0.6rem 0.85rem',
    border: '1px solid #fcd34d',
    background: '#fffbeb',
    color: '#78350f',
    borderRadius: '10px',
    fontSize: '0.92rem',
  },
  link: { color: '#78350f', fontWeight: 700 },
} as const;

export function PendingBanner({ banner }: { banner: PendingBannerData | null | undefined }) {
  if (!banner || banner.count <= 0) return null;
  const n = banner.count;
  return (
    <div role="status" style={style.box} data-testid="pending-banner" data-count={n}>
      <span>
        <strong>
          {n} {n === 1 ? 'change awaits' : 'changes await'} confirmation
        </strong>{' '}
        ({banner.modules.join(', ')}) — nothing applies until it is confirmed.
      </span>
      <Link to={banner.href} style={style.link} data-testid="pending-banner-link">
        Review →
      </Link>
    </div>
  );
}
