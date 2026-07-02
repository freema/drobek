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

export function meta() {
  return [{ title: 'Enter code — drobek' }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '24rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  label: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginBottom: '0.35rem',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.6rem 0.75rem',
    fontSize: '1.5rem',
    letterSpacing: '0.4em',
    textAlign: 'center',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
  },
  button: {
    marginTop: '0.9rem',
    width: '100%',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: '8px',
    padding: '0.6rem 0.75rem',
    fontSize: '0.9rem',
    marginBottom: '1rem',
  },
  foot: {
    marginTop: '1.25rem',
    fontSize: '0.85rem',
    color: '#555',
    display: 'flex',
    justifyContent: 'space-between',
  },
} as const;

export default function LoginVerifyRoute() {
  const { email, masked } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Enter your code</h1>
      <p style={styles.hint}>
        We sent a 6-digit code to <b>{masked}</b>. It is valid for 10 minutes.
      </p>

      {actionData?.error ? (
        <div style={styles.error} role="alert">
          {actionData.error}
        </div>
      ) : null}

      <Form method="post">
        <input type="hidden" name="email" value={email} />
        <label htmlFor="code" style={styles.label}>
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
          style={styles.input}
        />
        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? 'Verifying…' : 'Sign in'}
        </button>
      </Form>

      <div style={styles.foot}>
        <Link to="/login" style={{ color: '#1a1a1a' }}>
          ← Request a new code
        </Link>
        <span>valid 10 minutes</span>
      </div>
    </main>
  );
}
