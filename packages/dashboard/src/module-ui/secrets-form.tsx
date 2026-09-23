/**
 * The module's secrets (M2-02, NSO-291): WRITE-ONLY. Each declared secret
 * shows its name, description and whether (and when) it is set — never the
 * value; the input is an empty password field that is never pre-filled, and
 * the action redirects after storing, so the value appears in no response.
 * Set / Rotate / Remove are editor+ (a viewer sees the status only).
 */
import { Form } from 'react-router';
import { formatTimestamp } from '../view.js';
import { ui } from './styles.js';

export interface SecretRow {
  name: string;
  description: string;
  required: boolean;
  hasSecret: boolean;
  updatedAt: string | null;
}

export function SecretsForm({
  secrets,
  canEdit,
  busy,
  error,
}: {
  secrets: SecretRow[];
  canEdit: boolean;
  busy?: boolean;
  /** An action error of one secret (its name + messages; never the value). */
  error?: { target?: string; messages: string[] } | null;
}) {
  if (secrets.length === 0) return null;
  return (
    <div id="secrets" data-testid="secrets">
      <p style={ui.hint}>
        Values are encrypted and never shown again — not here, not to your agent. To change one, enter a new value (rotate).
      </p>
      {secrets.map((s) => (
        // Keyed by the set time: a stored value remounts the row, so the typed value leaves the DOM too.
        <div key={`${s.name}:${s.updatedAt ?? ''}`} style={ui.panel} data-testid="secret-row" data-name={s.name}>
          <div style={ui.row}>
            <code style={{ ...ui.mono, fontWeight: 700 }}>{s.name}</code>
            {s.required ? <span style={ui.badge}>required</span> : null}
            {s.hasSecret ? (
              <span style={ui.okBadge} data-testid="secret-status">
                set
              </span>
            ) : (
              <span style={s.required ? ui.warnBadge : ui.badge} data-testid="secret-status">
                not set
              </span>
            )}
            {s.hasSecret && s.updatedAt ? <span style={ui.small}>updated {formatTimestamp(s.updatedAt)}</span> : null}
          </div>
          <p style={{ ...ui.small, margin: '0.3rem 0 0.5rem' }}>{s.description}</p>
          {error && error.target === s.name ? (
            <div style={ui.error} role="alert" data-testid="secret-error">
              {error.messages.join(' ')}
            </div>
          ) : null}
          {canEdit ? (
            <div style={ui.row}>
              <Form method="post" style={{ ...ui.row, flex: '1 1 18rem' }} autoComplete="off">
                <input type="hidden" name="intent" value="set-secret" />
                <input type="hidden" name="secret" value={s.name} />
                <label htmlFor={`secret-${s.name}`} style={{ position: 'absolute', left: '-9999px' }}>
                  {s.hasSecret ? `New value for ${s.name}` : `Value for ${s.name}`}
                </label>
                <input
                  id={`secret-${s.name}`}
                  type="password"
                  name="value"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={s.hasSecret ? 'New value (rotate)' : 'Value'}
                  style={{ ...ui.input, flex: '1 1 12rem', width: 'auto' }}
                  data-testid={`secret-input-${s.name}`}
                />
                <button type="submit" style={ui.button} disabled={busy} data-testid={`secret-set-${s.name}`}>
                  {s.hasSecret ? 'Rotate' : 'Set'}
                </button>
              </Form>
              {s.hasSecret ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="remove-secret" />
                  <input type="hidden" name="secret" value={s.name} />
                  <button type="submit" style={ui.dangerButton} disabled={busy} data-testid={`secret-remove-${s.name}`}>
                    Remove
                  </button>
                </Form>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
