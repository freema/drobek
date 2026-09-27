/**
 * NSO-366: "Publishing on this server needs approval from <e-mail>" — shown
 * on every app page and on the workspace's apps list while the workspace may
 * not publish (PUBLISH_APPROVAL=approval, not approved). Client-safe: feed it
 * `publishApprovalView(…)` from the loader (publish-approval.server.ts);
 * `null` renders nothing. An editor+ gets "Request approval" unless a request
 * already went out in the last 24 hours (the operator got it by e-mail).
 */
import { Form, useLocation } from 'react-router';
import { controls } from '@drobek/tenancy/layout';

export interface PublishApprovalView {
  /** The operator's address (OPERATOR_EMAIL or a super-admin). */
  contact: string | null;
  /** "Publishing on this server needs approval from …" */
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
  return (
    <div
      role="status"
      data-testid="publish-approval-notice"
      data-requested={approval.requestPending ? '1' : '0'}
      style={{
        background: '#fffbeb',
        border: '1px solid #fde68a',
        color: '#92400e',
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
        {approval.requestPending && approval.requestedAt
          ? `An approval request was sent on ${when(approval.requestedAt)}; you can publish once it is approved.`
          : 'Building, versions and previews work as usual; a publish asks the operator for approval automatically.'}
      </span>
      {canRequest && !approval.requestPending ? (
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
