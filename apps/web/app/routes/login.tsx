import {
  data,
  Form,
  redirect,
  useActionData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import {
  createEmailLoginCode,
  getClientIp,
  normalizeAuthEmail,
} from '~/lib/auth/email-code.server';
import {
  guardOtpRequest,
  logOtpSent,
  releaseOtpCooldown,
} from '~/lib/auth/otp-guard.server';
import { getSessionUser } from '~/lib/auth/session.server';
import { logger, serializeError } from '~/lib/logger.server';
import { maskEmail } from '~/lib/mask-email';

export function meta() {
  return [{ title: 'Sign in — drobek' }];
}

// Server-side sanity check; the input itself is type=email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getSessionUser(request);
  if (user) throw redirect('/me');
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const raw = String(form.get('email') ?? '');
  const email = normalizeAuthEmail(raw);

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return data(
      { error: 'Enter a valid email address.' },
      { status: 400 }
    );
  }

  const ip = getClientIp(request);

  // Layered protection: kill switch → per-IP → per-email → global brake.
  const decision = await guardOtpRequest({ ip, email });
  if (!decision.ok) {
    // Generic redirect to verify (anti-enumeration / dedup) — nothing new sent.
    if (decision.kind === 'redirect_verify') {
      throw redirect(`/login/verify?${new URLSearchParams({ email })}`);
    }
    return data({ error: decision.message }, { status: decision.status });
  }

  const code = await createEmailLoginCode(email, ip);

  try {
    const { sendLoginCodeEmail } = await import(
      '~/lib/email/send-login-code.server'
    );
    await sendLoginCodeEmail({ email, code });
  } catch (err) {
    // Send failed → release the cooldown so the user can retry right away.
    await releaseOtpCooldown(email);
    logger.error('[login] sendLoginCodeEmail failed', {
      err: serializeError(err),
      email: maskEmail(email),
    });
    return data(
      { error: 'We could not send the email. Please try again in a moment.' },
      { status: 502 }
    );
  }

  logOtpSent({ ip, email });
  throw redirect(`/login/verify?${new URLSearchParams({ email })}`);
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
} as const;

export default function LoginRoute() {
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Sign in</h1>
      <p style={styles.hint}>
        Enter your email and we&apos;ll send you a one-time 6-digit code. No
        password needed.
      </p>

      {actionData?.error ? (
        <div style={styles.error} role="alert">
          {actionData.error}
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
    </main>
  );
}
