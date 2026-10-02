/**
 * /me — client half: the account page. Your workspaces (quick switch), how to
 * connect an agent (MCP URL + a short client picker, every snippet copyable),
 * which workspace the agent uses, a first prompt while that workspace is
 * empty, where to manage access (Connections, API keys), changing the
 * sign-in e-mail (new address → code from the e-mail) and the way to
 * deleting the account (/me/delete). Client-safe:
 * data arrives shaped from ./me.server.ts.
 */
import { useState, type CSSProperties } from 'react';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { DashboardPage, controls, mergeStyles, workspaceHref } from '@drobek/tenancy/layout';
import { CopyBlock } from '../copy-block.js';
import type { EmailChangeActionData, loader } from './me.server.js';

export function meta() {
  return [{ title: 'Your account — drobek' }];
}

const styles = {
  h1: { fontSize: '1.75rem', margin: '0 0 0.25rem' },
  h2: { fontSize: '1.15rem', margin: '0 0 0.35rem' },
  hint: { color: '#555', margin: '0 0 0.5rem', fontSize: '0.95rem' },
  row: { display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0.5rem 0 1rem', flexWrap: 'wrap' },
  email: { fontWeight: 600, fontSize: '1.05rem', overflowWrap: 'anywhere', minWidth: 0 },
  badge: {
    display: 'inline-block',
    padding: '0.15rem 0.6rem',
    fontSize: '0.75rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: '#7c2d12',
    background: '#ffedd5',
    border: '1px solid #fdba74',
    borderRadius: '999px',
  },
  navRow: { display: 'flex', flexWrap: 'wrap', gap: '0.3rem 1rem', margin: '0 0 1.5rem' },
  navLink: { fontWeight: 600, color: '#1a1a1a' },
  section: {
    margin: '0 0 1.25rem',
    padding: '1rem 1.25rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
  },
  wsList: { listStyle: 'none', padding: 0, margin: '0.5rem 0 0' },
  wsItem: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5rem',
    flexWrap: 'wrap',
    padding: '0.4rem 0',
    borderTop: '1px solid #f0f0f2',
  },
  wsName: { fontWeight: 600, color: '#1a1a1a', overflowWrap: 'anywhere', minWidth: 0 },
  muted: { color: '#71717a', fontSize: '0.85rem', overflowWrap: 'anywhere', minWidth: 0 },
  defaultTag: { color: '#166534', fontSize: '0.8rem', fontWeight: 600 },
  label: { margin: '0.8rem 0 0', fontSize: '0.9rem', fontWeight: 600 },
  picker: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem', margin: '0.5rem 0 0.25rem' },
  step: { margin: '0.5rem 0 0', fontSize: '0.92rem', overflowWrap: 'anywhere' },
  fieldLabel: { display: 'block', margin: '0.8rem 0 0', fontSize: '0.9rem', fontWeight: 600 },
  formRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.35rem 0 0' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    margin: '0.75rem 0 0',
    overflowWrap: 'anywhere',
  },
  notice: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#14532d',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.92rem',
    margin: '0 0 1rem',
    overflowWrap: 'anywhere',
  },
} satisfies Record<string, CSSProperties>;

const pickerOn = mergeStyles(controls.button, { height: '2rem' });
const pickerOff = mergeStyles(controls.secondaryButton, { height: '2rem' });

type Data = Awaited<ReturnType<typeof loader>>;

function ClientPicker({ clients }: { clients: Data['clients'] }) {
  const [selected, setSelected] = useState(clients[0]?.id ?? '');
  const client = clients.find((c) => c.id === selected) ?? clients[0];
  if (!client) return null;
  return (
    <div data-testid="me-clients">
      <p style={styles.label}>Your agent</p>
      <div style={styles.picker} role="group" aria-label="Choose your agent">
        {clients.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelected(c.id)}
            aria-pressed={c.id === client.id}
            style={c.id === client.id ? pickerOn : pickerOff}
            data-testid="me-client"
            data-client={c.id}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div data-testid="me-client-steps" data-client={client.id}>
        {client.steps.map((s, i) =>
          s.kind === 'code' ? (
            <CopyBlock key={`${client.id}-${i}`} value={s.code} label={s.label} testId={`me-step-${i}`} />
          ) : (
            <p key={`${client.id}-${i}`} style={styles.step}>
              {s.text}
            </p>
          )
        )}
      </div>
    </div>
  );
}

function SignInEmail({ email, superAdmin }: { email: string; superAdmin: boolean }) {
  const result = useActionData() as EmailChangeActionData | undefined;
  const busy = useNavigation().state !== 'idle';
  return (
    <section style={styles.section} data-testid="me-email">
      <h2 style={styles.h2}>Sign-in e-mail</h2>
      <p style={styles.hint}>
        You sign in with <strong>{email}</strong>. To sign in with another address, enter it below: we e-mail a code
        to the new address, and the address changes once you type that code here. Your other sessions are then signed
        out; your workspaces, API keys and agent connections stay.
      </p>
      {superAdmin ? (
        <p style={styles.hint} data-testid="me-email-super-admin">
          Your super-admin rights come with this address (it is listed in this server&rsquo;s SUPERADMIN_EMAIL). With a
          new address you lose them, unless the server operator lists the new address too.
        </p>
      ) : null}
      {result?.error ? (
        <p style={styles.error} role="alert" data-testid="me-email-error">
          {result.error}
        </p>
      ) : null}
      {result?.stage === 'code' ? (
        <>
          <p style={styles.step} role="status" data-testid="me-email-code-sent">
            {result.sent
              ? `We e-mailed a 6-digit code to ${result.email}.`
              : `A code was e-mailed to ${result.email} a moment ago; use the newest one.`}{' '}
            It works once, for 10 minutes. Nothing changes until you type it here.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="email-change" />
            <input type="hidden" name="email" value={result.email} />
            <label htmlFor="me-email-code" style={styles.fieldLabel}>
              Code from the e-mail
            </label>
            <div style={styles.formRow}>
              <input
                id="me-email-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                style={{ ...controls.input, width: '9rem', letterSpacing: '0.2em' }}
                data-testid="me-email-code"
              />
              <button type="submit" style={controls.button} disabled={busy} data-testid="me-email-confirm">
                Change my sign-in e-mail
              </button>
            </div>
          </Form>
          <div style={{ ...styles.formRow, marginTop: '0.75rem' }}>
            <Form method="post">
              <input type="hidden" name="intent" value="email-send-code" />
              <input type="hidden" name="email" value={result.email} />
              <button type="submit" style={controls.secondaryButton} disabled={busy} data-testid="me-email-resend">
                Send a new code
              </button>
            </Form>
            <Link to="/me" style={controls.link} data-testid="me-email-cancel">
              Use another address
            </Link>
          </div>
        </>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="email-send-code" />
          <label htmlFor="me-email-new" style={styles.fieldLabel}>
            New e-mail address
          </label>
          <div style={styles.formRow}>
            <input
              id="me-email-new"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              defaultValue={result?.email ?? ''}
              style={{ ...controls.input, flex: '1 1 14rem', minWidth: 0, maxWidth: '22rem' }}
              data-testid="me-email-new"
            />
            <button type="submit" style={controls.button} disabled={busy} data-testid="me-email-send-code">
              E-mail a code to it
            </button>
          </div>
        </Form>
      )}
    </section>
  );
}

export default function MeRoute() {
  const d = useLoaderData<typeof loader>();

  return (
    <DashboardPage crumbs={[{ label: 'Account' }]}>
      <h1 style={styles.h1}>Your account</h1>
      {d.emailChanged ? (
        <p style={styles.notice} role="status" data-testid="me-email-changed">
          You now sign in with <strong>{d.email}</strong>. Your other sessions were signed out; your API keys and agent
          connections keep working. A notice went to your previous address.
        </p>
      ) : null}
      <div style={styles.row}>
        <span style={styles.email} data-testid="me-account-email">
          {d.email}
        </span>
        {d.superAdmin ? <span style={styles.badge}>Super-admin</span> : null}
      </div>

      <nav style={styles.navRow} aria-label="Account">
        <Link to="/workspaces" style={styles.navLink}>
          Workspaces
        </Link>
        <Link to="/me/api-keys" style={styles.navLink} data-testid="me-api-keys-link">
          API keys
        </Link>
        <Link to="/me/connections" style={styles.navLink} data-testid="me-connections-link">
          Connections
        </Link>
      </nav>

      <section style={styles.section} data-testid="me-start">
        <h2 style={styles.h2}>Start building</h2>
        <p style={styles.hint}>
          Connect your agent to this MCP server once, then ask it to build an app. It works in your workspace and gives
          you a preview link.
        </p>
        <p style={styles.label}>MCP server URL</p>
        <CopyBlock value={d.mcpUrl} label="MCP URL" testId="me-mcp-url" />
        <ClientPicker clients={d.clients} />
        <p style={styles.step}>
          Signing in from the agent opens a consent page here; after you approve it, the agent is listed under{' '}
          <Link to="/me/connections" style={styles.navLink}>
            Connections
          </Link>
          . For scripts and CI without a browser, create an{' '}
          <Link to="/me/api-keys" style={styles.navLink}>
            API key
          </Link>{' '}
          instead. The{' '}
          <a href={d.agentGuideUrl} style={styles.navLink}>
            Agent guide
          </a>{' '}
          has the details.
        </p>
      </section>

      <section style={styles.section} data-testid="me-first-app">
        <h2 style={styles.h2}>Your first app</h2>
        <p style={styles.hint}>
          Your agent creates apps in your personal workspace{' '}
          <strong data-testid="me-default-workspace">/{d.personal.slug}</strong> unless you name another workspace by
          its slug.
        </p>
        {d.personal.appCount === 0 ? (
          <>
            <p style={styles.step}>
              That workspace has no apps yet. After you connected your agent above, paste this prompt into it:
            </p>
            <CopyBlock value={d.firstPrompt} label="First prompt" testId="me-first-prompt" />
          </>
        ) : (
          <p style={styles.step}>
            It has {d.personal.appCount} app{d.personal.appCount === 1 ? '' : 's'}.{' '}
            <Link to={workspaceHref(d.personal.slug)} style={styles.navLink}>
              Open its apps
            </Link>
          </p>
        )}
      </section>

      <section style={styles.section} data-testid="me-workspaces">
        <h2 style={styles.h2}>Your workspaces</h2>
        <ul style={styles.wsList}>
          {d.workspaces.map((ws) => (
            <li key={ws.slug} style={styles.wsItem} data-testid="me-workspace" data-slug={ws.slug}>
              <Link to={workspaceHref(ws.slug)} style={styles.wsName}>
                {ws.name}
              </Link>
              <span style={styles.muted}>
                /{ws.slug} · {ws.kind} · {ws.role}
              </span>
              {ws.personal ? <span style={styles.defaultTag}>your agent&rsquo;s default</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <SignInEmail key={d.email} email={d.email} superAdmin={d.superAdmin} />

      <section style={styles.section} data-testid="me-delete-account">
        <h2 style={styles.h2}>Delete your account</h2>
        <p style={styles.hint}>
          Deletes your account, your personal workspace with its apps and the team workspaces only you use, and ends
          your sessions, API keys and agent connections. You leave the other workspaces; what you made there stays.
          A code e-mailed to you confirms it.
        </p>
        <Link to="/me/delete" style={controls.dangerButton} data-testid="me-delete-account-link">
          Delete account…
        </Link>
      </section>

      <Form method="post" action="/auth/logout">
        <button type="submit" style={controls.secondaryButton}>
          Sign out
        </button>
      </Form>
    </DashboardPage>
  );
}
