/**
 * /feedback/new — client half: the note form the preview's Feedback button
 * opens. Shows what the note is pinned to (app, version, page, spot), takes
 * the text, and after Send says where the note can be found.
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './feedback.new.server.js';

export function meta({ data }: { data?: { app?: { name?: string } } }) {
  return [{ title: `Feedback on ${data?.app?.name ?? 'an app'} — drobek` }, { name: 'robots', content: 'noindex' }];
}

const styles = {
  main: { fontFamily: 'system-ui, sans-serif', maxWidth: '34rem', margin: '0 auto', padding: '2rem 1.25rem', color: '#1a1a1a', lineHeight: 1.55 },
  eyebrow: { color: '#555', fontSize: '0.85rem', margin: 0 },
  h1: { fontSize: '1.4rem', margin: '0.2rem 0 0.6rem' },
  context: { border: '1px solid #e4e4e7', borderRadius: '10px', padding: '0.7rem 0.9rem', background: '#fafafa', fontSize: '0.88rem', margin: '0 0 1rem' },
  dt: { color: '#555', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0.35rem 0 0' },
  dd: { margin: 0, wordBreak: 'break-word' },
  label: { display: 'block', fontWeight: 600, margin: '0 0 0.35rem' },
  textarea: {
    width: '100%',
    minHeight: '9rem',
    padding: '0.6rem 0.7rem',
    fontSize: '0.95rem',
    fontFamily: 'inherit',
    border: '1px solid #d4d4d8',
    borderRadius: '8px',
    boxSizing: 'border-box',
  },
  hint: { color: '#555', fontSize: '0.82rem', margin: '0.35rem 0 0' },
  row: { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1rem' },
  button: { padding: '0.6rem 1.1rem', fontSize: '1rem', fontFamily: 'inherit', fontWeight: 600, color: '#fff', background: '#1a1a1a', border: 'none', borderRadius: '8px', cursor: 'pointer' },
  error: { background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.6rem 0.9rem', borderRadius: '8px', marginTop: '1rem', fontSize: '0.9rem' },
  done: { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.8rem 0.9rem', borderRadius: '8px', fontSize: '0.95rem' },
  small: { color: '#555', fontSize: '0.8rem', marginTop: '1.5rem' },
} as const;

export default function FeedbackNewRoute() {
  const page = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const c = page.context;

  if (result && result.ok) {
    return (
      <main style={styles.main}>
        <p style={styles.eyebrow}>Feedback on {page.app.name}</p>
        <div style={styles.done} role="status" data-testid="feedback-sent">
          <strong>Thanks — your note was sent.</strong> The people working on this app see it on its Feedback tab, and their coding
          agent can read it and mark it resolved once it is fixed. You can close this window.
        </div>
        <div style={styles.row}>
          <a href={page.feedbackTab} data-testid="feedback-tab-link">
            See all notes on this app
          </a>
          <a href={`?${new URLSearchParams({ app: page.app.slug, ...(c.version ? { v: String(c.version) } : {}), path: c.path }).toString()}`}>
            Write another note
          </a>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <p style={styles.eyebrow}>Feedback on the preview</p>
      <h1 style={styles.h1}>{page.app.name}</h1>
      <dl style={styles.context} data-testid="feedback-context">
        <dt style={styles.dt}>Version</dt>
        <dd style={styles.dd}>{c.version !== null ? `Version ${c.version}` : 'The current preview'}</dd>
        <dt style={styles.dt}>Page</dt>
        <dd style={styles.dd}>
          <a href={c.pageUrl} target="_blank" rel="noopener noreferrer">
            {c.path}
          </a>
        </dd>
        <dt style={styles.dt}>Spot</dt>
        <dd style={styles.dd} data-testid="feedback-spot">
          {c.spot}
        </dd>
      </dl>
      <Form method="post">
        <input type="hidden" name="app" value={page.app.slug} />
        {c.version !== null ? <input type="hidden" name="v" value={c.version} /> : null}
        <input type="hidden" name="path" value={c.path} />
        {c.anchor ? (
          <>
            <input type="hidden" name="x" value={c.anchor.x} />
            <input type="hidden" name="y" value={c.anchor.y} />
            <input type="hidden" name="vw" value={c.anchor.vw} />
            <input type="hidden" name="vh" value={c.anchor.vh} />
            {c.anchor.selector ? <input type="hidden" name="sel" value={c.anchor.selector} /> : null}
          </>
        ) : null}
        <label style={styles.label} htmlFor="feedback-body">
          What did you notice?
        </label>
        <textarea
          id="feedback-body"
          name="body"
          required
          maxLength={page.bodyMax}
          defaultValue={result && !result.ok ? result.body : ''}
          style={styles.textarea}
          placeholder="e.g. The price overlaps the button on a narrow screen."
          data-testid="feedback-body"
        />
        <p style={styles.hint}>
          Plain text, up to {page.bodyMax} characters. Everyone in the workspace {page.workspace.name} and their coding agents can read it.
        </p>
        <div style={styles.row}>
          <button type="submit" style={styles.button} disabled={busy} data-testid="feedback-send">
            {busy ? 'Sending…' : 'Send note'}
          </button>
        </div>
      </Form>
      {result && !result.ok ? (
        <p style={styles.error} role="alert" data-testid="feedback-error">
          {result.error}
        </p>
      ) : null}
      <p style={styles.small}>Signed in as {page.email}.</p>
    </main>
  );
}
