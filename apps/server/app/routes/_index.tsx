/**
 * The apex landing of a drobek instance (NSO-331): what an anonymous visitor
 * of a self-hosted core sees. Neutral copy about the open-source instance —
 * the agent loop over MCP, the platform modules, the dashboard — with links
 * to the agent guide, /llms.txt, the source repository and sign-in. External
 * URLs come from the packages that own them, through the loader.
 *
 * LANDING_URL: an operator with their own website (drobek.app's is on
 * www.drobek.app) sends the apex `/` there with a 301 instead, so the
 * dashboard host (noindex) never competes with the website in search.
 */
import { redirect, useLoaderData } from 'react-router';
import { AGENT_GUIDE_URL } from '@drobek/agent-dx';
import { SOURCE_REPO_URL } from '@drobek/dashboard/footer';

const DESCRIPTION =
  'drobek is an open-source cloud workspace for agent-built web apps: your agent connects over MCP, writes files, gets the compile result back and hands you a live preview to publish.';

export function meta() {
  return [
    { title: 'drobek — a cloud workspace for agent-built web apps' },
    { name: 'description', content: DESCRIPTION },
  ];
}

/** The LANDING_URL target when it is a valid http(s) URL, else null. */
export function landingRedirectUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.LANDING_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function loader() {
  const target = landingRedirectUrl();
  if (target) throw redirect(target, 301);
  return { agentGuideUrl: AGENT_GUIDE_URL, repoUrl: SOURCE_REPO_URL };
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
  nav: { display: 'flex', justifyContent: 'flex-end' },
  link: { color: '#1a1a1a', fontWeight: 600 },
  h1: { fontSize: '2.25rem', marginBottom: '0.25rem' },
  tagline: { color: '#555', marginTop: 0 },
  h2: { fontSize: '1.25rem', marginTop: '2rem' },
  list: { paddingLeft: '1.25rem' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  muted: { color: '#777', fontSize: '0.85rem', marginTop: '2rem' },
} as const;

const MODULES: ReadonlyArray<readonly [name: string, what: string]> = [
  ['auth', 'sign-in for the people who use the app'],
  ['data', 'collections of records with per-operation rules'],
  ['forms', 'form submissions'],
  ['email', 'notifications to the app’s owners'],
  ['files', 'end-user uploads with a per-app quota'],
  ['proxy', 'calls to registered third-party APIs, the key injected server-side'],
];

export function Landing({ agentGuideUrl, repoUrl }: ReturnType<typeof loader>) {
  return (
    <main style={styles.main}>
      <nav style={styles.nav} aria-label="Account">
        <a href="/login" style={styles.link}>
          Sign in
        </a>
      </nav>
      <h1 style={styles.h1}>drobek</h1>
      <p style={styles.tagline}>
        A cloud workspace for agent-built web apps. Your agent connects over MCP
        and works directly in your drobek workspace; drobek compiles every write,
        keeps it as a version and serves it on a preview URL.
      </p>

      <h2 style={styles.h2}>How it works</h2>
      <ol style={styles.list}>
        <li>
          <strong>Connect.</strong> Add the MCP endpoint to Claude Code, Codex or
          Cursor and sign in with OAuth.
        </li>
        <li>
          <strong>Write.</strong> The agent creates an app and writes its files.
        </li>
        <li>
          <strong>Compile.</strong> drobek compiles each write with esbuild and
          returns the diagnostics to the agent, which fixes its own errors.
        </li>
        <li>
          <strong>Preview.</strong> Every write is a version with an instant
          preview URL.
        </li>
        <li>
          <strong>Publish.</strong> The agent publishes only when you ask, and
          any earlier version can be restored.
        </li>
      </ol>

      <h2 style={styles.h2}>Platform modules</h2>
      <p>App backends are TypeScript platform modules the agent turns on per app:</p>
      <ul style={styles.list}>
        {MODULES.map(([name, what]) => (
          <li key={name}>
            <span style={styles.mono}>{name}</span> — {what}
          </li>
        ))}
      </ul>

      <h2 style={styles.h2}>The dashboard</h2>
      <p>
        You keep the controls. Secrets are set write-only in the dashboard and
        never pass through the agent; risky module changes wait for your
        confirmation; custom domains, app data and app users are managed there
        too.
      </p>

      <h2 style={styles.h2}>Open source, self-hostable</h2>
      <p>
        drobek is AGPL-3.0 licensed: one Node process with Postgres and Redis. Run
        your own instance from the{' '}
        <a href={repoUrl} style={styles.link}>
          source repository
        </a>
        .
      </p>

      <h2 style={styles.h2}>Get started</h2>
      <ul style={styles.list}>
        <li>
          <a href="/login" style={styles.link}>
            Sign in
          </a>{' '}
          to your workspace on this instance.
        </li>
        <li>
          <a href="/build-with-your-agent" style={styles.link}>
            Build with your agent
          </a>{' '}
          — connect the MCP server and install the skill.
        </li>
        <li>
          <a href={agentGuideUrl} style={styles.link}>
            Agent guide
          </a>{' '}
          — the tools, the briefing and the skills in one document.
        </li>
        <li>
          <a href="/llms.txt" style={styles.link}>
            /llms.txt
          </a>{' '}
          — the concise index for agents.
        </li>
        <li>
          <a href={repoUrl} style={styles.link}>
            GitHub
          </a>{' '}
          — the source code and the self-hosting guide.
        </li>
      </ul>

      <p style={styles.muted}>
        This instance: <a href="/healthz">/healthz</a> (service health) ·{' '}
        <a href="/api/version">/api/version</a> (running build).
      </p>
    </main>
  );
}

export default function Index() {
  return <Landing {...useLoaderData<typeof loader>()} />;
}
