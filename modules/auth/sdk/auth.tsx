/**
 * `import { LoginGate, useAuth } from 'drobek/auth'` — the auth module's
 * React part (M1-02). NOT in /__drobek/sdk.js: the drobek compiler builds
 * this file INTO the app that imports it, resolving `react` through the app's
 * own drobek.json (the app and the gate share one React) and `drobek` to the
 * server's SDK (the same `drobek.auth` instance the app sees).
 *
 * Self-contained on purpose: it may import only `react` and `drobek`.
 */
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { drobek } from 'drobek';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export interface LoginGateProps {
  /** What signed-in users see; a function gets the user. */
  children: ReactNode | ((user: User) => ReactNode);
  /** Heading of the sign-in form (default "Sign in"). */
  title?: string;
  /** Only admins get through; other signed-in users see "no access" and a sign-out button. */
  requireAdmin?: boolean;
  /** Shown while the session is checked (default: nothing). */
  loading?: ReactNode;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

// One `me()` in flight for every useAuth()/LoginGate on the page.
let inflight: Promise<User | null> | null = null;
function loadUser(): Promise<User | null> {
  inflight ??= drobek.auth.me().finally(() => {
    inflight = null;
  });
  return inflight;
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : '';
}

function messageFor(err: unknown, step: 'email' | 'code' | 'session'): string {
  switch (errorCode(err)) {
    case 'email_not_allowed':
      return 'This e-mail address cannot sign in to this app.';
    case 'rate_limited':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'invalid_code':
      return 'That code is not valid. Check the e-mail and try again.';
    case 'too_many_attempts':
      return 'Too many wrong codes. Request a new code.';
    case 'limit_exceeded':
      return 'This app cannot take new users right now.';
    case 'unavailable':
      return 'Sign-in is unavailable right now. Try again in a moment.';
    case 'invalid_request':
      return step === 'code' ? 'Enter the 6-digit code from the e-mail.' : 'Enter a valid e-mail address.';
    default:
      return step === 'session' ? 'Could not check your sign-in.' : 'Something went wrong. Try again.';
  }
}

/** The signed-in user of this app host (null when signed out), kept in sync with drobek.auth. */
export function useAuth(): { user: User | null; loading: boolean; error: string | null; logout(): Promise<void>; refresh(): Promise<void> } {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, error: null });
  const refresh = useCallback(async () => {
    try {
      const user = await loadUser();
      setState({ user, loading: false, error: null });
    } catch (err) {
      setState((s) => ({ user: s.user, loading: false, error: messageFor(err, 'session') }));
    }
  }, []);
  useEffect(() => {
    const off = drobek.auth.onChange((user) => setState({ user, loading: false, error: null }));
    void refresh();
    return off;
  }, [refresh]);
  const logout = useCallback(() => drobek.auth.logout(), []);
  return { ...state, logout, refresh };
}

const S: Record<string, CSSProperties> = {
  box: {
    maxWidth: 360,
    margin: '10vh auto',
    padding: 24,
    display: 'grid',
    gap: 12,
    fontFamily: 'system-ui, sans-serif',
    border: '1px solid rgba(127, 127, 127, 0.35)',
    borderRadius: 12,
  },
  title: { margin: 0, fontSize: '1.25rem' },
  label: { display: 'grid', gap: 6 },
  input: { font: 'inherit', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(127, 127, 127, 0.5)' },
  button: { font: 'inherit', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' },
  link: {
    font: 'inherit',
    justifySelf: 'start',
    padding: 0,
    border: 0,
    background: 'none',
    color: 'inherit',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  note: { margin: 0, opacity: 0.8 },
  error: { margin: 0, color: '#c0362c' },
};

function Box(props: { title: string; children: ReactNode }) {
  return (
    <div className="drobek-login" style={S.box}>
      <h2 style={S.title}>{props.title}</h2>
      {props.children}
    </div>
  );
}

function LoginForm({ title }: { title: string }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const sent = await drobek.auth.sendCode(email);
      setEmail(sent.email);
      setCode('');
      setStep('code');
      setNote(`We sent a 6-digit code to ${sent.email}. It is valid for ${Math.round(sent.expires_in / 60)} minutes.`);
    } catch (err) {
      setError(messageFor(err, 'email'));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await drobek.auth.verify(email, code);
      // drobek.auth.onChange hands the user to the gate, which unmounts this form.
    } catch (err) {
      if (errorCode(err) === 'too_many_attempts') {
        setStep('email');
        setNote(null);
      }
      setCode('');
      setError(messageFor(err, 'code'));
      setBusy(false);
    }
  }

  if (step === 'email') {
    return (
      <Box title={title}>
        <form onSubmit={sendCode} style={{ display: 'grid', gap: 12 }}>
          <label style={S.label}>
            Email
            <input
              style={S.input}
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" style={S.error}>
              {error}
            </p>
          )}
          <button type="submit" style={S.button} disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      </Box>
    );
  }

  return (
    <Box title={title}>
      <form onSubmit={verify} style={{ display: 'grid', gap: 12 }}>
        {note && <p style={S.note}>{note}</p>}
        <label style={S.label}>
          Code
          <input
            style={S.input}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        {error && (
          <p role="alert" style={S.error}>
            {error}
          </p>
        )}
        <button type="submit" style={S.button} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" style={S.link} disabled={busy} onClick={() => void sendCode()}>
          Send a new code
        </button>
        <button
          type="button"
          style={S.link}
          disabled={busy}
          onClick={() => {
            setStep('email');
            setError(null);
            setNote(null);
          }}
        >
          Use a different e-mail
        </button>
      </form>
    </Box>
  );
}

/** Shows `children` to signed-in users of this app host, the e-mail code sign-in to everyone else. */
export function LoginGate({ children, title = 'Sign in', requireAdmin = false, loading = null }: LoginGateProps) {
  const auth = useAuth();
  if (auth.loading) return <>{loading}</>;
  if (!auth.user && auth.error) {
    return (
      <Box title={title}>
        <p role="alert" style={S.error}>
          {auth.error}
        </p>
        <button type="button" style={S.button} onClick={() => void auth.refresh()}>
          Try again
        </button>
      </Box>
    );
  }
  if (!auth.user) return <LoginForm title={title} />;
  if (requireAdmin && auth.user.role !== 'admin') {
    return (
      <Box title="No access">
        <p style={S.note}>{auth.user.email} is signed in, but only admins of this app can open this.</p>
        <button type="button" style={S.button} onClick={() => void auth.logout()}>
          Sign out
        </button>
      </Box>
    );
  }
  return <>{typeof children === 'function' ? children(auth.user) : children}</>;
}
