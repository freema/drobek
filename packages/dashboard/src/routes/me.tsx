/**
 * /me — client half: the account page. Your workspaces (quick switch), how to
 * connect an agent (MCP URL + a short client picker, every snippet copyable),
 * which workspace the agent uses, a first prompt while that workspace is
 * empty, and where to manage access (Connections, API keys). Client-safe:
 * data arrives shaped from ./me.server.ts.
 */
import { useState, type CSSProperties } from 'react';
import { Form, Link, useLoaderData } from 'react-router';
import { DashboardPage, controls, mergeStyles, workspaceHref } from '@drobek/tenancy/layout';
import { CopyBlock } from '../copy-block.js';
import type { loader } from './me.server.js';

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

export default function MeRoute() {
  const d = useLoaderData<typeof loader>();

  return (
    <DashboardPage crumbs={[{ label: 'Account' }]}>
      <h1 style={styles.h1}>Your account</h1>
      <div style={styles.row}>
        <span style={styles.email}>{d.email}</span>
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

      <Form method="post" action="/auth/logout">
        <button type="submit" style={controls.secondaryButton}>
          Sign out
        </button>
      </Form>
    </DashboardPage>
  );
}
