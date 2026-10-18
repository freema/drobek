/**
 * "Show QR" on the app page: a <details> (opens without JavaScript) with the
 * QR code of an app address and the address under it, for opening the app
 * on a phone. The symbol is computed by the loader (`appQrView`); this only
 * draws it as an SVG on a white tile, whatever the page's colours.
 */
import type { AppQrView, QrSymbol } from './qr.js';

const styles = {
  details: { fontSize: '0.85rem' },
  summary: { cursor: 'pointer', color: '#52525b', width: 'fit-content' },
  body: {
    display: 'inline-flex',
    flexDirection: 'column',
    gap: '0.4rem',
    marginTop: '0.5rem',
    maxWidth: '100%',
  },
  tile: { background: '#ffffff', padding: '0.25rem', borderRadius: '6px', border: '1px solid #e4e4e7', width: 'fit-content' },
  url: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' },
  note: { color: '#71717a', margin: 0 },
} as const;

export function QrCode({ symbol, label }: { symbol: QrSymbol; label: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${symbol.size} ${symbol.size}`}
      width="176"
      height="176"
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      data-url={symbol.url}
      data-testid="app-qr-code"
      style={{ display: 'block' }}
    >
      <rect width={symbol.size} height={symbol.size} fill="#ffffff" />
      <path d={symbol.path} fill="#000000" />
    </svg>
  );
}

/** One address's "Show QR"; the preview's also says when there is no live address yet. */
export function QrDetails({ qr, kind }: { qr: AppQrView; kind: 'preview' | 'live' }) {
  const symbol = kind === 'preview' ? qr.preview : qr.live;
  if (!symbol) return null;
  const what = kind === 'preview' ? 'the preview' : 'the live app';
  return (
    <details style={styles.details} data-testid="app-qr" data-kind={kind}>
      <summary style={styles.summary}>Show QR</summary>
      <div style={styles.body}>
        <div style={styles.tile}>
          <QrCode symbol={symbol} label={`QR code that opens ${what} at ${symbol.url}`} />
        </div>
        <span style={styles.url}>{symbol.url}</span>
        <p style={styles.note}>Scan it with a phone camera to open {what}.</p>
        {qr.passwordGate ? (
          <p style={styles.note} data-testid="app-qr-password">
            Opens the password page first.
          </p>
        ) : null}
        {kind === 'preview' && qr.live === null ? (
          <p style={styles.note} data-testid="app-qr-unpublished">
            Publish to get a live address.
          </p>
        ) : null}
      </div>
    </details>
  );
}
