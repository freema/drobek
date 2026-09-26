/**
 * /oauth/authorize — consent UI (U5, M0-04). Client half; server logic
 * (validation, login bounce, code issuance) lives in ./oauth.authorize.server.ts.
 * Names the requesting client (and, for a CIMD client, the host that vouches
 * for that name) and offers the three scope checkboxes. There is no workspace
 * choice: the grant is bound to the user and reaches the workspaces they are
 * a member of, with their role in each.
 */
import { Form, useLoaderData } from 'react-router';
import { SCOPES } from '../scopes.js';
import type { loader } from './oauth.authorize.server.js';

export function meta() {
  return [{ title: 'Authorize access — drobek' }];
}

/** Human labels for the scope vocabulary shown on the consent screen. */
const SCOPE_LABELS: Record<string, string> = {
  read: 'See your workspaces and apps, read app files, the platform skills and the data your apps store',
  write: 'Change apps: create apps, write files, restore versions and configure platform modules',
  publish: 'Publish app versions to their live URL and list apps in the public gallery (after you say yes)',
};

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '30rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  eyebrow: {
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#6d28d9',
  },
  h1: { fontSize: '1.6rem', margin: '0.25rem 0 0.5rem' },
  lede: { color: '#444', fontSize: '0.98rem', marginTop: 0 },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    margin: '1.25rem 0 0.35rem',
  },
  note: { color: '#555', fontSize: '0.85rem', marginTop: '0.75rem' },
  muted: { color: '#9ca3af' },
  scopeList: {
    listStyle: 'none',
    padding: 0,
    margin: '0.5rem 0 0',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
  },
  scopeItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.6rem',
    padding: '0.6rem 0.8rem',
    borderTop: '1px solid #f0f0f2',
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '1.75rem',
  },
  allow: {
    flex: 1,
    padding: '0.7rem 1rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#fff',
    background: '#6d28d9',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  deny: {
    flex: 1,
    padding: '0.7rem 1rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  errorBox: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '10px',
    padding: '1rem',
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.85rem',
  },
} as const;

export default function OAuthAuthorizeRoute() {
  const loaderData = useLoaderData<typeof loader>();

  if (!loaderData.ok) {
    return (
      <main style={styles.main}>
        <div style={styles.eyebrow}>drobek · authorization</div>
        <h1 style={styles.h1}>This request cannot be authorized</h1>
        <div style={styles.errorBox} role="alert" data-testid="oauth-error">
          <strong>{loaderData.error}</strong>
          <div>{loaderData.errorDescription}</div>
        </div>
      </main>
    );
  }

  const { clientName, clientHost, redirectHost, requested, params } = loaderData;

  return (
    <main style={styles.main}>
      <div style={styles.eyebrow}>drobek · authorization</div>
      <h1 style={styles.h1}>{clientName} wants access to your drobek account</h1>
      <p style={styles.lede}>
        {clientHost ? (
          <>
            Identified by <span style={styles.code}>{clientHost}</span>.{' '}
          </>
        ) : null}
        Approving grants <b>{clientName}</b> an MCP token for you. It reaches
        every workspace you are a member of, limited by your role in each. You
        will be returned to <span style={styles.code}>{redirectHost}</span>.
      </p>

      <Form method="post" data-testid="consent-form">
        <input type="hidden" name="client_id" value={params.clientId} />
        <input type="hidden" name="redirect_uri" value={params.redirectUri} />
        <input type="hidden" name="response_type" value={params.responseType} />
        <input type="hidden" name="code_challenge" value={params.codeChallenge} />
        <input
          type="hidden"
          name="code_challenge_method"
          value={params.codeChallengeMethod}
        />
        <input type="hidden" name="state" value={params.state} />
        <input type="hidden" name="resource" value={params.resource} />
        <input type="hidden" name="scope" value={params.scope} />

        <div style={styles.label}>Permissions</div>
        <ul style={styles.scopeList} data-testid="scope-list">
          {SCOPES.map((scope) => {
            const offered = requested.includes(scope);
            return (
              <li key={scope} style={styles.scopeItem}>
                <input
                  type="checkbox"
                  id={`scope_${scope}`}
                  name={`scope_${scope}`}
                  defaultChecked={offered}
                  disabled={!offered}
                  data-testid={`scope-${scope}`}
                />
                <label htmlFor={`scope_${scope}`} style={offered ? undefined : styles.muted}>
                  <span style={styles.code}>{scope}</span>
                  {offered ? null : ' (not requested)'}
                  <br />
                  {SCOPE_LABELS[scope] ?? scope}
                </label>
              </li>
            );
          })}
        </ul>
        <p style={styles.note}>Uncheck anything you do not want to grant.</p>

        <div style={styles.actions}>
          <button
            type="submit"
            name="decision"
            value="deny"
            style={styles.deny}
            data-testid="consent-deny"
          >
            Deny
          </button>
          <button
            type="submit"
            name="decision"
            value="allow"
            style={styles.allow}
            data-testid="consent-approve"
          >
            Allow access
          </button>
        </div>
      </Form>
    </main>
  );
}
