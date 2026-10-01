/**
 * The dedicated editors of the built-in modules:
 *
 *  - `CollectionsEditor` (data): one card per collection with the rule table
 *    operation × principal (checkboxes; nothing checked = `none`) and the
 *    collection's JSON Schema in a textarea (validated on the server — the
 *    module compiles it with ajv); add / remove a collection;
 *  - `UpstreamsEditor` (proxy): the upstreams assigned to the app as cards
 *    with the `call` rule, `rateLimit` and unassign; the workspace's other
 *    upstreams as a compact list (name, methods · prefixes, whether its
 *    secret is set) whose assign form opens per entry, with a name filter
 *    once the list is long.
 *
 * Every save goes through the configure path, so a relaxation (e.g. `create`
 * opened to Anyone, a newly assigned upstream) becomes a pending change that
 * waits for confirmation instead of applying. A viewer sees everything
 * disabled, with no button.
 */
import { useState } from 'react';
import { Form } from 'react-router';
import { PRINCIPALS, PRINCIPAL_LABEL, ruleInputName, ruleToPrincipals, type FieldValue, type PrincipalName } from '../module-config.js';
import { ui } from './styles.js';

export interface EditorError {
  intent: string;
  target?: string;
  fields: Record<string, string[]>;
  general: string[];
  values?: Record<string, FieldValue>;
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
    // On a phone the table scrolls inside its box, never the page.
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

/** Above this many unassigned upstreams the compact list gets a name filter. */
const UPSTREAM_FILTER_THRESHOLD = 8;

function upstreamsHref(workspaceSlug: string): string {
  return `/workspaces/${encodeURIComponent(workspaceSlug)}/upstreams`;
}

function errorMessages(error: EditorError | null | undefined, name: string): string[] {
  const mine = error && error.target === name ? error : null;
  return [...(mine?.general ?? []), ...Object.entries(mine?.fields ?? {}).flatMap(([p, m]) => m.map((x) => `${p}: ${x}`))];
}

/** Assigned upstreams, and those the app's config names but the workspace no longer has, get the full card. */
function isOnApp(u: UpstreamRow): boolean {
  return u.assigned || !u.registered;
}

function SecretBadge({ hasSecret }: { hasSecret: boolean }) {
  return <span style={hasSecret ? ui.okBadge : ui.badge}>{hasSecret ? 'secret set' : 'no secret'}</span>;
}

function Allowed({ u }: { u: UpstreamRow }) {
  if (!u.methods.length && !u.prefixes.length) return null;
  return (
    <p style={{ ...ui.small, margin: '0.3rem 0 0' }} data-testid={`upstream-allowed-${u.name}`}>
      {u.methods.join(', ')}
      {u.prefixes.length ? ` · ${u.prefixes.join(', ')}` : ''}
    </p>
  );
}

function RulesFields({ u, readOnly, messages }: { u: UpstreamRow; readOnly: boolean; messages: string[] }) {
  return (
    <>
      <RuleTable
        rows={[{ op: 'call', rule: u.assigned ? u.call : 'user' }]}
        principals={CALL_PRINCIPALS}
        readOnly={readOnly}
        testPrefix={`call-${u.name}`}
      />
      <label style={ui.label} htmlFor={`rl-${u.name}`}>
        Calls per minute from this app <span style={ui.muted}>(optional; the app-wide limit applies too)</span>
      </label>
      <input
        id={`rl-${u.name}`}
        name="rateLimit"
        inputMode="numeric"
        defaultValue={u.rateLimit ?? ''}
        disabled={readOnly}
        style={{ ...ui.input, display: 'block', width: '8rem', marginTop: '0.3rem' }}
        data-testid={`upstream-ratelimit-${u.name}`}
      />
      <Errors messages={messages} testId={`upstream-error-${u.name}`} />
    </>
  );
}

function AssignedCard({
  u,
  workspaceSlug,
  readOnly,
  busy,
  messages,
}: {
  u: UpstreamRow;
  workspaceSlug: string;
  readOnly: boolean;
  busy?: boolean;
  messages: string[];
}) {
  const body = <RulesFields u={u} readOnly={readOnly} messages={messages} />;
  return (
    <section style={ui.panel} data-testid={`upstream-${u.name}`}>
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
        <SecretBadge hasSecret={u.hasSecret} />
      </div>
      <Allowed u={u} />
      {readOnly ? (
        body
      ) : (
        <>
          <Form method="post" noValidate id={`upstream-form-${u.name}`}>
            <input type="hidden" name="intent" value="save-upstream" />
            <input type="hidden" name="upstream" value={u.name} />
            {body}
          </Form>
          {u.registered ? null : (
            <p style={{ ...ui.small, margin: '0.6rem 0 0' }} data-testid={`upstream-unregistered-${u.name}`}>
              Register “{u.name}” on the <a href={upstreamsHref(workspaceSlug)}>Upstreams page</a> first; then save it here and confirm.
            </p>
          )}
          <div style={{ ...ui.row, marginTop: '0.75rem' }}>
            <button
              type="submit"
              form={`upstream-form-${u.name}`}
              style={ui.button}
              disabled={busy || !u.registered}
              data-testid={`upstream-save-${u.name}`}
            >
              {u.assigned ? 'Save' : 'Assign to this app'}
            </button>
            {u.assigned ? (
              <Form method="post">
                <input type="hidden" name="intent" value="unassign-upstream" />
                <input type="hidden" name="upstream" value={u.name} />
                <button type="submit" style={ui.dangerButton} disabled={busy} data-testid={`upstream-unassign-${u.name}`}>
                  Unassign
                </button>
              </Form>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function UnassignedItem({
  u,
  readOnly,
  busy,
  messages,
  hidden,
}: {
  u: UpstreamRow;
  readOnly: boolean;
  busy?: boolean;
  messages: string[];
  hidden: boolean;
}) {
  return (
    <li
      hidden={hidden}
      style={{ padding: '0.55rem 0', borderTop: '1px solid #f0f0f2' }}
      data-testid={`upstream-${u.name}`}
      data-upstream-name={u.name}
    >
      <div style={ui.row}>
        <code style={{ ...ui.mono, fontWeight: 700 }}>{u.name}</code>
        <SecretBadge hasSecret={u.hasSecret} />
      </div>
      <Allowed u={u} />
      {readOnly ? null : (
        <details open={messages.length > 0} style={{ marginTop: '0.35rem' }} data-testid={`upstream-assign-${u.name}`}>
          <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }} data-testid={`upstream-assign-open-${u.name}`}>
            Assign to this app…
          </summary>
          <Form method="post" noValidate style={{ marginTop: '0.5rem' }}>
            <input type="hidden" name="intent" value="save-upstream" />
            <input type="hidden" name="upstream" value={u.name} />
            <RulesFields u={u} readOnly={false} messages={messages} />
            <button type="submit" style={{ ...ui.button, marginTop: '0.6rem' }} disabled={busy} data-testid={`upstream-save-${u.name}`}>
              Assign to this app
            </button>
          </Form>
        </details>
      )}
    </li>
  );
}

function UnassignedList({
  upstreams,
  readOnly,
  busy,
  error,
}: {
  upstreams: UpstreamRow[];
  readOnly: boolean;
  busy?: boolean;
  error?: EditorError | null;
}) {
  const [query, setQuery] = useState('');
  const filterable = upstreams.length > UPSTREAM_FILTER_THRESHOLD;
  const needle = filterable ? query.trim().toLowerCase() : '';
  const matches = (u: UpstreamRow) => !needle || u.name.toLowerCase().includes(needle);
  const shown = upstreams.filter(matches).length;
  return (
    <div style={ui.panel} data-testid="upstreams-unassigned">
      <p style={{ margin: '0 0 0.3rem', fontWeight: 700 }}>Other upstreams in this workspace ({upstreams.length})</p>
      <p style={{ ...ui.small, margin: '0 0 0.5rem' }}>
        {readOnly
          ? 'This app cannot call these upstreams.'
          : 'This app cannot call these yet. Open one to choose who may call it, then assign it; the assignment waits for confirmation.'}
      </p>
      {filterable ? (
        <div style={{ marginBottom: '0.5rem' }}>
          <label style={ui.label} htmlFor="upstream-filter">
            Filter by name
          </label>
          <input
            id="upstream-filter"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. news"
            autoComplete="off"
            style={{ ...ui.input, maxWidth: '20rem', marginTop: '0.3rem' }}
            data-testid="upstream-filter"
          />
        </div>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {upstreams.map((u) => (
          <UnassignedItem
            key={`${u.name}:${u.rateLimit ?? ''}`}
            u={u}
            readOnly={readOnly}
            busy={busy}
            messages={errorMessages(error, u.name)}
            hidden={!matches(u)}
          />
        ))}
      </ul>
      {shown === 0 ? (
        <p style={{ ...ui.muted, margin: '0.4rem 0 0' }} data-testid="upstream-filter-empty">
          No upstream name contains “{query.trim()}”. Clear the filter to see all {upstreams.length}.
        </p>
      ) : null}
    </div>
  );
}

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
  const onApp = upstreams.filter(isOnApp);
  const others = upstreams.filter((u) => !isOnApp(u));
  return (
    <div id="upstreams" data-testid="upstreams-editor">
      <p style={ui.hint}>
        Upstreams are registered for the whole workspace (base URL, allowed paths, the secret) on the{' '}
        <a href={upstreamsHref(workspaceSlug)}>Upstreams page</a>. Here you choose which of them this app may call and who may call
        them. Assigning one, or opening it to Anyone, waits for confirmation.
      </p>
      {upstreams.length === 0 ? (
        <p style={ui.muted} data-testid="upstreams-none">
          This workspace has no upstreams yet. Register one on the <a href={upstreamsHref(workspaceSlug)}>Upstreams page</a>, then
          assign it to this app here.
        </p>
      ) : null}
      {upstreams.length > 0 && onApp.length === 0 ? (
        <p style={ui.muted} data-testid="upstreams-none-assigned">
          {readOnly ? 'No upstream is assigned to this app.' : 'No upstream is assigned to this app yet. Open one in the list below to assign it.'}
        </p>
      ) : null}
      {onApp.map((u) => (
        <AssignedCard
          key={`${u.name}:${u.assigned}:${u.call}:${u.rateLimit ?? ''}`}
          u={u}
          workspaceSlug={workspaceSlug}
          readOnly={readOnly}
          busy={busy}
          messages={errorMessages(error, u.name)}
        />
      ))}
      {upstreams.length > 0 && others.length === 0 ? (
        <p style={ui.muted} data-testid="upstreams-all-assigned">
          Every upstream of this workspace is assigned to this app. To add another, register it on the{' '}
          <a href={upstreamsHref(workspaceSlug)}>Upstreams page</a>.
        </p>
      ) : null}
      {others.length > 0 ? <UnassignedList upstreams={others} readOnly={readOnly} busy={busy} error={error} /> : null}
    </div>
  );
}
