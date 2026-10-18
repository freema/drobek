/**
 * /login/verify — client half of the route module (component + meta). Server
 * code lives in ./login.verify.server.ts; loader/action types imported
 * type-only.
 */
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';
import type { action, loader } from './login.verify.server.js';
import { PlatformPage } from '../platform-page.js';

export function meta() {
  return [{ title: 'Enter code — drobek' }];
}

const codeInput = {
  fontSize: '1.5rem',
  letterSpacing: '0.4em',
  textAlign: 'center',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

const foot = { marginTop: '1.25rem', display: 'flex', justifyContent: 'space-between', gap: '1rem' } as const;

export default function LoginVerifyRoute() {
  const { email, masked } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <PlatformPage page="login-verify">
      <h1>Enter your code</h1>
      <p className="drobek-hint">
        We sent a 6-digit code to <b>{masked}</b>. It is valid for 10 minutes.
      </p>

      {actionData?.error ? (
        <div className="drobek-error" role="alert">
          {actionData.error}
        </div>
      ) : null}

      <Form method="post">
        <input type="hidden" name="email" value={email} />
        <label htmlFor="code" className="drobek-label">
          Code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          autoComplete="one-time-code"
          autoFocus
          placeholder="000000"
          className="drobek-input"
          style={codeInput}
        />
        <button type="submit" disabled={submitting} className="drobek-button drobek-button-block">
          {submitting ? 'Verifying…' : 'Sign in'}
        </button>
      </Form>

      <div style={foot} className="drobek-small">
        <Link to="/login">← Request a new code</Link>
        <span>valid 10 minutes</span>
      </div>
    </PlatformPage>
  );
}
