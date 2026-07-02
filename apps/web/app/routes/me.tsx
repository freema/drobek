import { Form, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { requireSessionUser } from '~/lib/auth/session.server';
import { isSuperAdmin } from '~/lib/auth/super-admin.server';

export function meta() {
  return [{ title: 'Your account — drobek' }];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  return {
    email: user.email,
    superAdmin: isSuperAdmin(user.email),
  };
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '38rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  hint: { color: '#555', marginTop: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    margin: '1.25rem 0',
    flexWrap: 'wrap',
  },
  email: { fontWeight: 600, fontSize: '1.05rem' },
  badge: {
    display: 'inline-block',
    padding: '0.15rem 0.6rem',
    fontSize: '0.75rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: '#7c2d12',
    background: '#ffedd5',
    border: '1px solid #fdba74',
    borderRadius: '999px',
  },
  button: {
    padding: '0.5rem 1rem',
    fontSize: '0.95rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    cursor: 'pointer',
  },
} as const;

export default function MeRoute() {
  const { email, superAdmin } = useLoaderData<typeof loader>();

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Your account</h1>
      <p style={styles.hint}>You are signed in.</p>

      <div style={styles.row}>
        <span style={styles.email}>{email}</span>
        {superAdmin ? <span style={styles.badge}>Super-admin</span> : null}
      </div>

      <Form method="post" action="/auth/logout">
        <button type="submit" style={styles.button}>
          Sign out
        </button>
      </Form>
    </main>
  );
}
