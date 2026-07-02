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

export function meta() {
  return [{ title: 'Sign in — drobek' }];
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
    fontSize: '1rem',
    fontFamily: 'inherit',
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
  // U3: "Continue with Google" — same footprint as the primary button,
  // inverted colors so the email form stays the visual default.
  googleLink: {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    textAlign: 'center',
    textDecoration: 'none',
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    margin: '1.25rem 0',
    color: '#888',
    fontSize: '0.8rem',
  },
  dividerLine: { flex: 1, height: 1, background: '#e4e4e7' },
} as const;

export default function LoginRoute() {
  const { googleEnabled, googleError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';
  const error = actionData?.error ?? googleError;

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Sign in</h1>
      <p style={styles.hint}>
        Enter your email and we&apos;ll send you a one-time 6-digit code. No
        password needed.
      </p>

      {error ? (
        <div style={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <Form method="post">
        <label htmlFor="email" style={styles.label}>
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
          style={styles.input}
        />
        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? 'Sending…' : 'Send code'}
        </button>
      </Form>

      {googleEnabled ? (
        <>
          <div style={styles.divider} aria-hidden="true">
            <span style={styles.dividerLine} />
            <span>or</span>
            <span style={styles.dividerLine} />
          </div>
          <a href="/auth/google" style={styles.googleLink}>
            Continue with Google
          </a>
        </>
      ) : null}
    </main>
  );
}
