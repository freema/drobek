/**
 * Why this workspace may not publish — shown on every app page and
 * on the workspace's apps list. Client-safe: feed it `publishApprovalView(…)`
 * from the loader (publish-approval.server.ts); `null` renders nothing.
 *  - `blocked`: "Publishing from this workspace was turned off by the
 *    operator (<e-mail>)." — no button, the contact is the way back;
 *  - `approval` (PUBLISH_APPROVAL=approval, not allowed): "Publishing on this
 *    server needs approval from <e-mail>" — an editor+ gets "Request
 *    approval" unless a request already went out in the last 24 hours (the
 *    operator got it by e-mail).
 */
import { Form, useLocation } from 'react-router';
import { controls } from '@drobek/tenancy/layout';

export interface PublishApprovalView {
  /** `blocked` — the operator turned publishing off; `approval` — it waits for the operator's approval. */
  kind: 'blocked' | 'approval';
  /** The operator's address (OPERATOR_EMAIL or a super-admin). */
  contact: string | null;
  /** "Publishing from this workspace was turned off by the operator (…)." / "Publishing on this server needs approval from …" */
  notice: string;
  /** ISO time of the last approval request, if any. */
  requestedAt: string | null;
  /** A request went out within the dedupe window: no button, "request sent". */
  requestPending: boolean;
}

export const REQUEST_PUBLISH_APPROVAL_INTENT = 'request-publish-approval';

function when(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function PublishApprovalNotice({
  approval,
  canRequest,
  action,
  busy = false,
}: {
  approval: PublishApprovalView | null | undefined;
  canRequest: boolean;
  /** Where the request form posts (default: the current route). */
  action?: string;
  busy?: boolean;
}) {
  const location = useLocation();
  if (!approval) return null;
  const blocked = approval.kind === 'blocked';
  return (
    <div
      role="status"
      data-testid="publish-approval-notice"
      data-kind={approval.kind}
      data-requested={approval.requestPending ? '1' : '0'}
      style={{
        background: blocked ? '#fef2f2' : '#fffbeb',
        border: blocked ? '1px solid #fecaca' : '1px solid #fde68a',
        color: blocked ? '#991b1b' : '#92400e',
        padding: '0.7rem 0.95rem',
        borderRadius: '10px',
        margin: '1rem 0',
        fontSize: '0.92rem',
        lineHeight: 1.5,
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ flex: '1 1 18rem' }}>
        <strong data-testid="publish-approval-text">{approval.notice}</strong>{' '}
        {blocked
          ? `Building, versions and previews work as usual, and live apps keep serving. To publish again, contact ${approval.contact ?? 'the operator of this server'}.`
          : approval.requestPending && approval.requestedAt
            ? `An approval request was sent on ${when(approval.requestedAt)}; you can publish once it is approved.`
            : 'Building, versions and previews work as usual; a publish asks the operator for approval automatically.'}
      </span>
      {!blocked && canRequest && !approval.requestPending ? (
        <Form method="post" action={action} style={{ display: 'inline' }}>
          <input type="hidden" name="intent" value={REQUEST_PUBLISH_APPROVAL_INTENT} />
          <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />
          <button type="submit" style={controls.secondaryButton} disabled={busy} data-testid="request-approval-button">
            Request approval
          </button>
        </Form>
      ) : null}
    </div>
  );
}
