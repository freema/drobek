import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  consumeEmailLoginCode,
  normalizeAuthEmail,
} from '~/lib/auth/email-code.server';
import { ensureUserByEmail } from '~/lib/auth/ensure-user.server';
import { createUserSession } from '~/lib/auth/session.server';
import { maskEmail } from '~/lib/mask-email';

export function meta() {
  return [{ title: 'Enter code — drobek' }];
}

// One generic, remaining-attempts-agnostic message for EVERY failure mode
// (wrong code / expired / invalidated) — no enumeration, no attempt counting.
const GENERIC_CODE_ERROR =
  'That code is not valid. Check it and try again, or request a new one.';

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('email');
  if (!raw) throw redirect('/login');
  const email = normalizeAuthEmail(raw);
  return { email, masked: maskEmail(email) };
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = normalizeAuthEmail(String(form.get('email') ?? ''));
  const code = String(form.get('code') ?? '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return data({ error: GENERIC_CODE_ERROR }, { status: 400 });
  }

  const consumed = await consumeEmailLoginCode(email, code);
  if (!consumed.ok) {
    return data({ error: GENERIC_CODE_ERROR }, { status: 400 });
  }

  const userId = await ensureUserByEmail(email);
  const { setCookie } = await createUserSession(userId, email);

  return redirect('/me', { headers: { 'Set-Cookie': setCookie } });
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
