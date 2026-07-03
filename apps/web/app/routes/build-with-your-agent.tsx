/**
 * M1b Agent DX (PHY-124) — `/build-with-your-agent`: the human-readable page
 * that links llms.txt, shows the one-command skill install, and points at the
 * MCP endpoint. Env-derived URLs come from the loader (server-side process.env).
 * Minimal style, matching the index page.
 */
import { useLoaderData } from 'react-router';
import {
  SKILL_INSTALL_COMMAND,
  TOOL_DOCS,
  mcpEndpoint,
  publicAppUrl,
} from '@drobek/agent-dx';

export function meta() {
  return [
    { title: 'Build with your agent — drobek' },
    {
      name: 'description',
      content:
        'Connect the drobek MCP server, install the drobek skill, and let your agent ship static micro-apps.',
    },
  ];
}

export function loader() {
  return {
    mcpUrl: mcpEndpoint(),
    appUrl: publicAppUrl(),
    installCommand: SKILL_INSTALL_COMMAND,
    tools: TOOL_DOCS.map((t) => ({
      name: t.name,
      title: t.title,
      scope: t.scope,
    })),
  };
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '42rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  nav: { display: 'flex', justifyContent: 'space-between' },
  link: { color: '#1a1a1a', fontWeight: 600 },
  h1: { fontSize: '2.25rem', marginBottom: '0.25rem' },
  tagline: { color: '#555', marginTop: 0 },
  h2: { fontSize: '1.25rem', marginTop: '2rem' },
  code: {
    display: 'block',
    background: '#f4f4f5',
    border: '1px solid #e4e4e7',
    borderRadius: '6px',
    padding: '0.75rem 1rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.9rem',
    overflowX: 'auto',
    whiteSpace: 'pre',
  },
  list: { paddingLeft: '1.25rem' },
  toolName: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 600,
  },
  scope: { color: '#777', fontSize: '0.85rem' },
} as const;

export default function BuildWithYourAgent() {
  const { mcpUrl, appUrl, installCommand, tools } =
    useLoaderData<typeof loader>();
  return (
    <main style={styles.main}>
      <nav style={styles.nav}>
        <a href="/" style={styles.link}>
          drobek
        </a>
        <a href="/login" style={styles.link}>
          Sign in
        </a>
      </nav>
      <h1 style={styles.h1}>Build with your agent</h1>
      <p style={styles.tagline}>
        Point Claude Code or Cursor at the drobek MCP server, install the drobek
        skill, and ship a static micro-app to a live URL — with an optional
        JSON-schema-backed Data API.
      </p>

      <h2 style={styles.h2}>1. Connect the MCP server</h2>
      <p>
        Add this OAuth 2.1 (PKCE S256) MCP endpoint to your agent&rsquo;s MCP
        client. Discovery, registration, and consent are automatic.
      </p>
      <code style={styles.code}>{mcpUrl}</code>

      <h2 style={styles.h2}>2. Install the drobek skill</h2>
      <p>From a checkout of this repo, one command:</p>
      <code style={styles.code}>{installCommand}</code>

      <h2 style={styles.h2}>3. Read the authoritative docs</h2>
      <ul style={styles.list}>
        <li>
          <a href="/llms.txt" style={styles.link}>
            /llms.txt
          </a>{' '}
          — the concise index for agents.
        </li>
        <li>
          <a href="/llms-full.txt" style={styles.link}>
            /llms-full.txt
          </a>{' '}
          — the full delivery-stack contract: every tool + input schema, the REST
          Data API, the deploy flow, limits, and the error catalogue.
        </li>
      </ul>
      <p style={styles.scope}>
        Web origin: {appUrl}. Once connected, agents can also read the{' '}
        <code>drobek://docs/llms-full</code> MCP resource without web access.
      </p>

      <h2 style={styles.h2}>Tools your agent gets</h2>
      <ul style={styles.list}>
        {tools.map((t) => (
          <li key={t.name}>
            <span style={styles.toolName}>{t.name}</span> — {t.title}{' '}
            <span style={styles.scope}>({t.scope})</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
