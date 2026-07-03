/**
 * /invite/:token — client half (U4, PHY-54): sign-in prompt for anonymous
 * visitors, accept button for signed-in ones, and the generic invalid-invite
 * ErrorBoundary (404) for expired/used/garbage tokens.
 */
import {
  Form,
  isRouteErrorResponse,
  Link,
  useLoaderData,
  useNavigation,
  useRouteError,
} from 'react-router';
import type { loader } from './invite.$token.server.js';

export function meta() {
  return [{ title: 'Workspace invite — drobek' }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '28rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  button: {
    marginTop: '1.1rem',
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
  loginLink: {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    marginTop: '1.1rem',
    padding: '0.6rem 0.75rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    textAlign: 'center',
    textDecoration: 'none',
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  back: { fontSize: '0.9rem', color: '#555', marginTop: '2rem' },
} as const;

export default function InviteAcceptRoute() {
  const { anonymous, workspaceName, role } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const submitting = nav.state !== 'idle';

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>You&apos;re invited</h1>
      <p style={styles.hint}>
        You have been invited to join <strong>{workspaceName}</strong> as{' '}
        <strong>{role}</strong>.
      </p>

      {anonymous ? (
        <>
          <p style={styles.hint}>
            Sign in first, then open this invite link again to accept it.
          </p>
          <a href="/login" style={styles.loginLink}>
            Sign in to accept
          </a>
        </>
      ) : (
        <Form method="post">
          <button type="submit" disabled={submitting} style={styles.button}>
            {submitting ? 'Accepting…' : 'Accept invite'}
          </button>
        </Form>
      )}
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const invalid = isRouteErrorResponse(error) && error.status === 404;

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Workspace invite</h1>
      <p style={styles.hint}>
        {invalid
          ? 'This invite is not valid or has expired.'
          : 'Unexpected error.'}
      </p>
      <p style={styles.back}>
        <Link to="/">← Home</Link>
      </p>
    </main>
  );
}
