/**
 * The dedicated editors of the built-in modules (M2-02, NSO-291):
 *
 *  - `CollectionsEditor` (data): one card per collection with the rule table
 *    operation × principal (checkboxes; nothing checked = `none`) and the
 *    collection's JSON Schema in a textarea (validated on the server — the
 *    module compiles it with ajv); add / remove a collection;
 *  - `UpstreamsEditor` (proxy): the workspace's upstreams (name, whether its
 *    secret is set) with assign / unassign, the `call` rule and `rateLimit`.
 *
 * Every save goes through the configure path, so a relaxation (e.g. `create`
 * opened to Anyone, a newly assigned upstream) becomes a pending change that
 * waits for confirmation instead of applying. A viewer sees everything
 * disabled, with no button.
 */
import { Form } from 'react-router';
import { PRINCIPALS, PRINCIPAL_LABEL, ruleInputName, ruleToPrincipals, type PrincipalName } from '../module-config.js';
import { ui } from './styles.js';

export interface EditorError {
  intent: string;
  target?: string;
  fields: Record<string, string[]>;
  general: string[];
  values?: Record<string, string | boolean>;
}

function Errors({ messages, testId }: { messages: string[]; testId: string }) {
  if (messages.length === 0) return null;
  return (
    <div style={ui.error} role="alert" data-testid={testId}>
      {messages.map((m) => (
        <div key={m}>{m}</div>
      ))}
    </div>
  );
}

function RuleTable({
  rows,
  principals,
  readOnly,
  testPrefix,
}: {
  rows: { op: string; meaning?: string; rule: string }[];
  principals: readonly PrincipalName[];
  readOnly: boolean;
  testPrefix: string;
}) {
  return (
    // On a phone the table scrolls inside its box, never the page (NSO-342).
    <div style={ui.tableWrap}>
      <table style={ui.table}>
        <thead>
          <tr>
            <th style={ui.th}>Operation</th>
            {principals.map((p) => (
              <th key={p} style={{ ...ui.th, ...ui.center }}>
                {PRINCIPAL_LABEL[p]}
              </th>
            ))}
            <th style={ui.th}>Rule</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = new Set(ruleToPrincipals(r.rule));
            return (
              <tr key={r.op}>
                <td style={ui.td}>
                  <strong>{r.op}</strong>
                  {r.meaning ? <span style={ui.desc}>{r.meaning}</span> : null}
                </td>
                {principals.map((p) => (
                  <td key={p} style={{ ...ui.td, ...ui.center }}>
                    <input
                      type="checkbox"
                      name={ruleInputName(r.op, p)}
                      defaultChecked={on.has(p)}
                      disabled={readOnly}
                      aria-label={`${r.op}: ${PRINCIPAL_LABEL[p]}`}
                      data-testid={`${testPrefix}-${r.op}-${p}`}
                    />
                  </td>
                ))}
                <td style={{ ...ui.td, ...ui.mono }} data-testid={`${testPrefix}-${r.op}-rule`}>
                  {r.rule}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface CollectionRow {
  name: string;
  rules: Record<string, string>;
  schemaText: string;
}

export function CollectionsEditor({
  collections,
  ops,
  canEdit,
  busy,
  error,
}: {
  collections: CollectionRow[];
  ops: { op: string; meaning: string }[];
  canEdit: boolean;
  busy?: boolean;
  error?: EditorError | null;
}) {
  const readOnly = !canEdit;
  return (
    <div id="collections" data-testid="collections-editor">
      <p style={ui.hint}>
        Who may do what with each collection’s records. <em>Record owner</em> is the signed-in user who created a record; nothing
        checked means nobody (<code>none</code>). Opening an operation to <em>Anyone</em> waits for confirmation.
      </p>
      {collections.length === 0 ? <p style={ui.muted}>No collections yet — your agent declares them, or add one below.</p> : null}
      {collections.map((c) => {
        const schemaPath = `collections.${c.name}.schema`;
        const mine = error && error.target === c.name ? error : null;
        const schemaErrors = mine?.fields[schemaPath] ?? [];
        const otherErrors = [
          ...(mine?.general ?? []),
          ...Object.entries(mine?.fields ?? {})
            .filter(([p]) => p !== schemaPath)
            .flatMap(([p, m]) => m.map((x) => `${p}: ${x}`)),
        ];
        const schemaValue = typeof mine?.values?.[schemaPath] === 'string' ? (mine.values[schemaPath] as string) : c.schemaText;
        const body = (
          <>
            <RuleTable
              rows={ops.map((o) => ({ op: o.op, meaning: o.meaning, rule: c.rules[o.op] ?? 'none' }))}
              principals={PRINCIPALS}
              readOnly={readOnly}
              testPrefix={`rule-${c.name}`}
            />
            <label style={ui.label} htmlFor={`schema-${c.name}`}>
              JSON Schema <span style={ui.muted}>(optional — every write must match it)</span>
            </label>
            <textarea
              id={`schema-${c.name}`}
              name="schema"
              defaultValue={schemaValue}
              disabled={readOnly}
              spellCheck={false}
              style={schemaErrors.length ? { ...ui.textarea, ...ui.inputError, minHeight: '7rem' } : { ...ui.textarea, minHeight: '7rem' }}
              aria-invalid={schemaErrors.length > 0 || undefined}
              data-testid={`collection-schema-${c.name}`}
            />
            {schemaErrors.length ? (
              <p style={ui.fieldError} role="alert" data-testid={`collection-schema-error-${c.name}`}>
                {schemaErrors.join(' · ')}
              </p>
            ) : null}
            <Errors messages={otherErrors} testId={`collection-error-${c.name}`} />
          </>
        );
        return (
          <section key={`${c.name}:${JSON.stringify(c.rules)}:${c.schemaText}`} style={ui.panel} data-testid={`collection-${c.name}`}>
            <p style={{ margin: '0 0 0.3rem', fontWeight: 700 }}>
              <code style={ui.mono}>{c.name}</code>
            </p>
            {readOnly ? (
              body
            ) : (
              <>
                <Form method="post" noValidate>
                  <input type="hidden" name="intent" value="save-collection" />
                  <input type="hidden" name="collection" value={c.name} />
                  {body}
                  <button type="submit" style={{ ...ui.button, marginTop: '0.5rem' }} disabled={busy} data-testid={`collection-save-${c.name}`}>
                    Save {c.name}
                  </button>
                </Form>
                <Form method="post" style={{ marginTop: '0.5rem' }}>
                  <input type="hidden" name="intent" value="remove-collection" />
                  <input type="hidden" name="collection" value={c.name} />
                  <button type="submit" style={ui.dangerButton} disabled={busy} data-testid={`collection-remove-${c.name}`}>
                    Remove collection (its records become unreachable)
                  </button>
                </Form>
              </>
            )}
          </section>
        );
      })}
      {canEdit ? (
        <Form method="post" style={{ ...ui.row, marginTop: '0.6rem' }} noValidate>
          <input type="hidden" name="intent" value="add-collection" />
          <label htmlFor="new-collection" style={ui.label}>
            New collection
          </label>
          <input
            id="new-collection"
            name="collection"
            placeholder="e.g. notes"
            autoComplete="off"
            style={{ ...ui.input, width: '14rem' }}
            data-testid="collection-add-name"
          />
          <button type="submit" style={ui.secondaryButton} disabled={busy} data-testid="collection-add">
            Add collection
          </button>
        </Form>
      ) : null}
      {error && (error.intent === 'add-collection' || (!error.target && error.intent.endsWith('collection'))) ? (
        <Errors messages={[...error.general, ...Object.values(error.fields).flat()]} testId="collection-add-error" />
      ) : null}
    </div>
  );
}

export interface UpstreamRow {
  name: string;
  registered: boolean;
  assigned: boolean;
  call: string;
  rateLimit: number | null;
  hasSecret: boolean;
  methods: string[];
  prefixes: string[];
}

const CALL_PRINCIPALS: readonly PrincipalName[] = ['public', 'user', 'admin'];

export function UpstreamsEditor({
  upstreams,
  workspaceSlug,
  canEdit,
  busy,
  error,
}: {
  upstreams: UpstreamRow[];
  workspaceSlug: string;
  canEdit: boolean;
  busy?: boolean;
  error?: EditorError | null;
}) {
  const readOnly = !canEdit;
  return (
    <div id="upstreams" data-testid="upstreams-editor">
      <p style={ui.hint}>
        Upstreams are registered for the whole workspace (base URL, allowed paths, the secret) on the{' '}
        <a href={`/workspaces/${encodeURIComponent(workspaceSlug)}/upstreams`}>Upstreams page</a>. Here you choose which of them this
        app may call and who may call them. Assigning one, or opening it to Anyone, waits for confirmation.
      </p>
      {upstreams.length === 0 ? <p style={ui.muted}>This workspace has no upstreams yet.</p> : null}
      {upstreams.map((u) => {
        const mine = error && error.target === u.name ? error : null;
        const messages = [...(mine?.general ?? []), ...Object.entries(mine?.fields ?? {}).flatMap(([p, m]) => m.map((x) => `${p}: ${x}`))];
        const body = (
          <>
            <RuleTable rows={[{ op: 'call', rule: u.assigned ? u.call : 'user' }]} principals={CALL_PRINCIPALS} readOnly={readOnly} testPrefix={`call-${u.name}`} />
            <label style={ui.label} htmlFor={`rl-${u.name}`}>
              Calls per minute from this app <span style={ui.muted}>(optional; the app-wide limit applies too)</span>
            </label>
            <input
              id={`rl-${u.name}`}
              name="rateLimit"
              inputMode="numeric"
              defaultValue={u.rateLimit ?? ''}
              disabled={readOnly}
              style={{ ...ui.input, width: '8rem' }}
              data-testid={`upstream-ratelimit-${u.name}`}
            />
            <Errors messages={messages} testId={`upstream-error-${u.name}`} />
          </>
        );
        return (
          <section key={`${u.name}:${u.assigned}:${u.call}:${u.rateLimit ?? ''}`} style={ui.panel} data-testid={`upstream-${u.name}`}>
            <div style={ui.row}>
              <code style={{ ...ui.mono, fontWeight: 700 }}>{u.name}</code>
              {u.assigned ? (
                <span style={ui.okBadge} data-testid="upstream-assigned">
                  assigned
                </span>
              ) : (
                <span style={ui.badge} data-testid="upstream-assigned">
                  not assigned
                </span>
              )}
              {u.registered ? null : <span style={ui.warnBadge}>not registered</span>}
              <span style={u.hasSecret ? ui.okBadge : ui.badge}>{u.hasSecret ? 'secret set' : 'no secret'}</span>
            </div>
            {u.methods.length || u.prefixes.length ? (
              <p style={{ ...ui.small, margin: '0.3rem 0 0' }}>
                {u.methods.join(', ')}
                {u.prefixes.length ? ` · ${u.prefixes.join(', ')}` : ''}
              </p>
            ) : null}
            {readOnly ? (
              u.assigned ? (
                body
              ) : null
            ) : (
              <>
                <Form method="post" noValidate>
                  <input type="hidden" name="intent" value="save-upstream" />
                  <input type="hidden" name="upstream" value={u.name} />
                  {body}
                  <button type="submit" style={{ ...ui.button, marginTop: '0.5rem' }} disabled={busy || !u.registered} data-testid={`upstream-save-${u.name}`}>
                    {u.assigned ? 'Save' : 'Assign to this app'}
                  </button>
                </Form>
                {u.assigned ? (
                  <Form method="post" style={{ marginTop: '0.5rem' }}>
                    <input type="hidden" name="intent" value="unassign-upstream" />
                    <input type="hidden" name="upstream" value={u.name} />
                    <button type="submit" style={ui.dangerButton} disabled={busy} data-testid={`upstream-unassign-${u.name}`}>
                      Unassign
                    </button>
                  </Form>
                ) : null}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
