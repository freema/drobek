/**
 * The pending change of one module (M2-02, NSO-291): who proposed it and
 * when, the module's own confirmRequired strings with a plain-language risk
 * note each, the readable before → after diff of the effective config, and
 * Confirm / Reject (editor+ only — a viewer sees the change, no button; the
 * action refuses a viewer with 403 anyway). A change the module marks
 * `confirmRole: 'admin'` (NSO-322 H3) is confirmed by a workspace admin only:
 * an editor sees why and can still reject it.
 */
import { Form } from 'react-router';
import { formatTimestamp } from '../view.js';
import type { DiffEntry } from '../module-config.js';
import { ui } from './styles.js';

export interface PendingPanelData {
  changes: { text: string; risk: string }[];
  diff: DiffEntry[];
  invalid: { path: string; message: string }[];
  proposedAt: string;
  proposedBy: string | null;
  /** Who may confirm: any editor, or only a workspace admin. */
  confirmRole?: 'editor' | 'admin';
  /** May THIS user confirm it (false: an editor facing an admin-only change)? */
  canConfirm?: boolean;
}

export function PendingPanel({ pending, canEdit, busy }: { pending: PendingPanelData | null; canEdit: boolean; busy?: boolean }) {
  if (!pending) return null;
  const when = pending.proposedAt ? formatTimestamp(pending.proposedAt) : null;
  return (
    <section style={ui.pendingPanel} id="pending" data-testid="pending-panel" aria-label="Change awaiting confirmation">
      <p style={{ margin: '0 0 0.4rem', fontWeight: 700 }}>Waiting for your confirmation</p>
      <p style={{ ...ui.small, margin: '0 0 0.6rem' }}>
        Proposed{pending.proposedBy ? ` for ${pending.proposedBy}` : ''}
        {when ? ` · ${when}` : ''}. The config in force stays until it is confirmed.
      </p>

      <ul style={{ margin: '0 0 0.7rem', paddingLeft: '1.1rem' }}>
        {pending.changes.map((c) => (
          <li key={c.text} data-testid="pending-change" style={{ marginBottom: '0.35rem' }}>
            {/* React escapes the module's text. */}
            <code style={ui.mono}>{c.text}</code>
            <br />
            <span style={{ fontSize: '0.85rem', color: '#92400e' }} data-testid="pending-risk">
              ⚠ {c.risk}
            </span>
          </li>
        ))}
      </ul>

      {pending.diff.length > 0 ? (
        <table style={ui.table} data-testid="pending-diff">
          <thead>
            <tr>
              <th style={ui.th}>Setting</th>
              <th style={ui.th}>Now</th>
              <th style={ui.th}>After confirming</th>
            </tr>
          </thead>
          <tbody>
            {pending.diff.map((d) => (
              <tr key={d.path} data-testid="pending-diff-row" data-path={d.path}>
                <td style={{ ...ui.td, ...ui.mono }}>{d.path}</td>
                <td style={{ ...ui.td, ...ui.mono, color: '#991b1b' }} data-testid="pending-diff-before">
                  {d.before}
                </td>
                <td style={{ ...ui.td, ...ui.mono, color: '#166534' }} data-testid="pending-diff-after">
                  {d.after}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {pending.invalid.length > 0 ? (
        <div style={ui.error} role="alert" data-testid="pending-invalid">
          This change no longer fits the current config and cannot be confirmed — reject it and ask the agent again.
          <ul style={{ margin: '0.3rem 0 0' }}>
            {pending.invalid.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <code style={ui.mono}>{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pending.confirmRole === 'admin' ? (
        <p style={ui.small} data-testid="pending-admin-only">
          Only a workspace admin can confirm this change{pending.canConfirm === false ? ' — you can reject it, or ask an admin to confirm it.' : '.'}
        </p>
      ) : null}

      {canEdit ? (
        <div style={ui.row}>
          <Form method="post">
            <input type="hidden" name="intent" value="confirm" />
            <button
              type="submit"
              style={ui.button}
              disabled={busy || pending.invalid.length > 0 || pending.canConfirm === false}
              data-testid="pending-confirm"
            >
              Confirm
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="reject" />
            <button type="submit" style={ui.secondaryButton} disabled={busy} data-testid="pending-reject">
              Reject
            </button>
          </Form>
        </div>
      ) : (
        <p style={ui.small}>An editor or workspace admin can confirm or reject it.</p>
      )}
    </section>
  );
}
