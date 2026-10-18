/**
 * /login — client half of the route module (component + meta). Server code
 * lives in ./login.server.ts; the loader/action types are imported type-only
 * so nothing server-side ever reaches the browser bundle.
 */
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import type { action, loader } from './login.server.js';
import { PlatformPage } from '../platform-page.js';

export function meta() {
  return [{ title: 'Sign in — drobek' }];
}

const divider = { display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.25rem 0 0' } as const;
const dividerLine = { flex: 1, height: 1, background: 'var(--drobek-line)' } as const;

export default function LoginRoute() {
  const { googleEnabled, googleError, docsUrl, accountDeleted } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';
  const error = actionData?.error ?? googleError;

  return (
    <PlatformPage page="login">
      <h1>Sign in</h1>
      <p className="drobek-hint">
        Enter your email and we&apos;ll send you a one-time 6-digit code. No
        password needed. A new email gets a new account.
      </p>

      {accountDeleted && !error ? (
        <div className="drobek-ok" role="status" data-testid="login-account-deleted">
          Your account was deleted, with your personal workspace and its apps. Signing in with the same address starts
          a new, empty account.
        </div>
      ) : null}

      {error ? (
        <div className="drobek-error" role="alert">
          {error}
        </div>
      ) : null}

      <Form method="post">
        <label htmlFor="email" className="drobek-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          placeholder="you@example.com"
          className="drobek-input"
        />
        <button type="submit" disabled={submitting} className="drobek-button drobek-button-block">
          {submitting ? 'Sending…' : 'Send code'}
        </button>
      </Form>

      {googleEnabled ? (
        <>
          <div style={divider} className="drobek-small" aria-hidden="true">
            <span style={dividerLine} />
            <span>or</span>
            <span style={dividerLine} />
          </div>
          <a href="/auth/google" className="drobek-button drobek-button-secondary drobek-button-block">
            Continue with Google
          </a>
        </>
      ) : null}

      <p className="drobek-hint" style={{ marginTop: '2rem' }}>
        drobek hosts the web apps your agent builds: connect it over MCP and
        it creates, previews and publishes them in your workspace.{' '}
        <a href={docsUrl} style={{ fontWeight: 600 }} data-testid="login-docs-link">
          Read the docs
        </a>
      </p>
    </PlatformPage>
  );
}
