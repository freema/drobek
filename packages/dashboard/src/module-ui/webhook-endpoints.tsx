/**
 * The endpoints of the module that receives webhooks (the one that declares
 * `webhooks`) on its module page: per endpoint the address to give the
 * sending service (copyable), how deliveries are verified, which secret and
 * whether it is set, the collection and the last delivery; below, the latest
 * deliveries. Values arrive pre-shaped from the loader; the secret values
 * themselves are set in the Secrets section of the same page.
 */
import type { WebhookDelivery, WebhookEndpointState } from '@drobek/modules';
import { CopyBlock } from '../copy-block.js';
import { formatTimestamp } from '../view.js';
import { ui } from './styles.js';

export interface WebhooksPanelData {
  /** null: the endpoints could not be loaded. */
  endpoints: (WebhookEndpointState & { hasSecret: boolean })[] | null;
  deliveries: WebhookDelivery[];
}

const STATUS_TEXT: Record<WebhookDelivery['status'], string> = {
  accepted: 'stored',
  rejected_signature: 'refused: not signed with the secret',
  duplicate: 'already stored (a retry)',
  too_large: 'refused: too large',
  rate_limited: 'refused: too many deliveries',
  collection_error: 'not stored: the collection refused it',
};

const REASON_TEXT: Record<string, string> = {
  secret_not_set: 'the secret is not set yet',
  missing_signature: 'no signature or token',
  bad_signature: 'the signature does not match',
  timestamp_out_of_tolerance: 'the signed time is too old (a replay)',
  validation_failed: 'the collection’s schema rejects it',
  quota_exceeded: 'the app’s data quota is full',
  not_found: 'the collection is not declared',
};

function statusBadge(status: WebhookDelivery['status'] | null) {
  if (status === null) return <span style={ui.badge}>no deliveries yet</span>;
  if (status === 'accepted' || status === 'duplicate') return <span style={ui.okBadge}>{STATUS_TEXT[status]}</span>;
  return <span style={ui.warnBadge}>{STATUS_TEXT[status]}</span>;
}

export function WebhookEndpointsPanel({ data }: { data: WebhooksPanelData }) {
  if (data.endpoints === null) {
    return (
      <div style={ui.error} role="alert" data-testid="webhooks-load-error">
        The endpoints could not be loaded. Reload the page; if it keeps failing, the server log names the cause.
      </div>
    );
  }
  return (
    <>
      <p style={ui.hint}>
        Give each address to the service that sends the events, and paste that service’s signing secret under Secrets below.
        Every delivery is checked against the secret and stored as a record of its collection; deliveries that fail the check
        are refused and listed here.
      </p>
      {data.endpoints.length === 0 ? (
        <p style={ui.muted} data-testid="webhooks-empty">
          No endpoints yet. Your agent adds one with configure_module(&apos;webhooks&apos;, …) and you confirm it here; the collection
          must be declared in the data module first.
        </p>
      ) : (
        data.endpoints.map((e) => (
          <div key={e.name} style={ui.panel} data-testid={`webhook-endpoint-${e.name}`} data-status={e.last_status ?? ''}>
            <div style={{ ...ui.row, justifyContent: 'space-between' }}>
              <strong style={ui.mono}>{e.name}</strong>
              {e.enabled ? statusBadge(e.last_status) : <span style={ui.badge}>disabled</span>}
            </div>
            <CopyBlock value={e.url} label={`the address of ${e.name}`} testId={`webhook-url-${e.name}`} />
            <dl style={ui.facts}>
              <dt style={ui.factKey}>Verified by</dt>
              <dd style={{ margin: 0 }}>
                <span style={ui.mono}>{e.verify}</span> — {e.signed ? 'a signature of every delivery' : 'a shared token, no signature: anyone with the address and token can post'}
              </dd>
              <dt style={ui.factKey}>Secret</dt>
              <dd style={{ margin: 0 }} data-testid={`webhook-secret-${e.name}`}>
                <span style={ui.mono}>{e.secret}</span> —{' '}
                {e.hasSecret ? 'set' : <span style={ui.warnBadge}>not set: deliveries are refused until you set it below</span>}
              </dd>
              <dt style={ui.factKey}>Stores in</dt>
              <dd style={{ margin: 0 }}>
                collection <span style={ui.mono}>{e.collection}</span>
              </dd>
              <dt style={ui.factKey}>Last delivery</dt>
              <dd style={{ margin: 0 }}>{e.last_delivery_at ? formatTimestamp(e.last_delivery_at) : 'never'}</dd>
            </dl>
          </div>
        ))
      )}

      <h3 style={{ fontSize: '1rem', margin: '1.25rem 0 0.25rem' }}>Latest deliveries</h3>
      {data.deliveries.length === 0 ? (
        <p style={ui.muted} data-testid="webhooks-deliveries-empty">
          No deliveries yet — they appear here as soon as the sending service posts to an address above.
        </p>
      ) : (
        <div style={ui.tableWrap}>
          <table style={ui.table} data-testid="webhook-deliveries">
            <thead>
              <tr>
                <th style={ui.th}>Received</th>
                <th style={ui.th}>Endpoint</th>
                <th style={ui.th}>Result</th>
                <th style={ui.th}>Size</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d, i) => (
                <tr key={`${d.received_at}-${d.endpoint}-${i}`} data-status={d.status}>
                  <td style={ui.td}>{formatTimestamp(d.received_at)}</td>
                  <td style={{ ...ui.td, ...ui.mono }}>{d.endpoint}</td>
                  <td style={ui.td}>
                    {statusBadge(d.status)}
                    {d.reason && d.status !== 'accepted' && d.status !== 'duplicate' ? ` — ${REASON_TEXT[d.reason] ?? d.reason}` : ''} (HTTP {d.http_status})
                  </td>
                  <td style={ui.td}>{d.bytes} bytes</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
