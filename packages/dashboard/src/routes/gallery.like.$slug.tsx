/**
 * /gallery/like/:slug — client half (NSO-340): a signed-in account likes or
 * unlikes a gallery app. After the button the page returns to the gallery
 * (`back`) when it came from there, otherwise it shows the new state.
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './gallery.like.$slug.server.js';

export function meta({ data }: { data?: { name?: string } }) {
  return [{ title: `Like ${data?.name ?? 'an app'} — drobek` }, { name: 'robots', content: 'noindex' }];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '34rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  eyebrow: { color: '#555', fontSize: '0.85rem', margin: 0 },
  h1: { fontSize: '1.75rem', margin: '0.2rem 0 0.4rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  count: { fontSize: '0.95rem', margin: '1rem 0' },
  row: { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.25rem' },
  button: {
    padding: '0.6rem 1.1rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#fff',
    background: '#1a1a1a',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  secondary: {
    padding: '0.6rem 1.1rem',
    fontSize: '1rem',
    fontFamily: 'inherit',
    fontWeight: 600,
    color: '#1a1a1a',
    background: '#fff',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    padding: '0.6rem 0.9rem',
    borderRadius: '8px',
    marginTop: '1rem',
    fontSize: '0.9rem',
  },
  small: { color: '#555', fontSize: '0.8rem', marginTop: '1.5rem' },
} as const;

export default function GalleryLikeRoute() {
  const page = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const current = result && result.ok ? result : page;
  const likes = current.likes;
  const liked = current.liked;

  return (
    <main style={styles.main}>
      <p style={styles.eyebrow}>drobek gallery</p>
      <h1 style={styles.h1}>{page.name}</h1>
      {page.description ? <p style={styles.hint}>{page.description}</p> : null}
      <p style={styles.count} data-testid="gallery-like-count">
        {likes === 1 ? '1 person likes this app' : `${likes} people like this app`}
        {liked ? ' — you are one of them.' : '.'}
      </p>
      <Form method="post">
        {page.back ? <input type="hidden" name="back" value={page.back} /> : null}
        <div style={styles.row}>
          {liked ? (
            <button type="submit" name="intent" value="unlike" style={styles.secondary} disabled={busy} data-testid="gallery-unlike">
              Remove my like
            </button>
          ) : (
            <button type="submit" name="intent" value="like" style={styles.button} disabled={busy} data-testid="gallery-like">
              ♥ Like this app
            </button>
          )}
          <a href={page.url}>Open the app</a>
          {page.back ? <a href={page.back}>Back to the gallery</a> : null}
        </div>
      </Form>
      {result && !result.ok ? (
        <p style={styles.error} role="alert">
          {result.error}
        </p>
      ) : null}
      <p style={styles.small}>
        Signed in as {page.email}. A like is one per account; the gallery shows only the count, never who liked.
      </p>
    </main>
  );
}
