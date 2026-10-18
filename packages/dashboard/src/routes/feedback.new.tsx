/**
 * /feedback/new — client half: the note form the preview's Feedback button
 * opens. Shows what the note is pinned to (app, version, page, and the spot:
 * the element's description, where on the page, its selector below), takes
 * the text and an optional screenshot, and after Send says where the note
 * can be found.
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { PlatformPage } from '@drobek/auth/platform-page';
import type { action, loader } from './feedback.new.server.js';
import { FeedbackScreenshotField } from '../feedback-screenshot.js';

export function meta({ data }: { data?: { app?: { name?: string } } }) {
  return [{ title: `Feedback on ${data?.app?.name ?? 'an app'} — drobek` }, { name: 'robots', content: 'noindex' }];
}

const styles = {
  dt: { color: 'var(--drobek-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0.35rem 0 0' },
  dd: { margin: 0, wordBreak: 'break-word' },
  row: { display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1rem' },
} as const;

export default function FeedbackNewRoute() {
  const page = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  const c = page.context;

  if (result && result.ok) {
    return (
      <PlatformPage page="feedback">
        <p className="drobek-eyebrow">Feedback on {page.app.name}</p>
        <div className="drobek-ok" role="status" data-testid="feedback-sent">
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
      </PlatformPage>
    );
  }

  return (
    <PlatformPage page="feedback">
      <p className="drobek-eyebrow">Feedback on the preview</p>
      <h1>{page.app.name}</h1>
      <dl className="drobek-box" style={{ fontSize: '0.88rem' }} data-testid="feedback-context">
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
          {c.spotParts?.label ? (
            <>
              <strong data-testid="feedback-spot-label">{c.spotParts.label}</strong> · {c.spotParts.where}
            </>
          ) : c.spotParts ? (
            c.spotParts.where
          ) : (
            c.spot
          )}
          {c.spotParts?.selector ? (
            <code className="drobek-small" style={{ display: 'block' }} data-testid="feedback-spot-selector">
              {c.spotParts.selector}
            </code>
          ) : null}
        </dd>
      </dl>
      <Form method="post" encType="multipart/form-data">
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
            {c.anchor.label ? <input type="hidden" name="label" value={c.anchor.label} /> : null}
          </>
        ) : null}
        <label className="drobek-label" htmlFor="feedback-body">
          What did you notice?
        </label>
        <textarea
          id="feedback-body"
          name="body"
          required
          maxLength={page.bodyMax}
          defaultValue={result && !result.ok ? result.body : ''}
          className="drobek-input"
          placeholder="e.g. The price overlaps the button on a narrow screen."
          data-testid="feedback-body"
        />
        <p className="drobek-small" style={{ marginTop: '0.35rem' }}>
          Plain text, up to {page.bodyMax} characters. Everyone in the workspace {page.workspace.name} and their coding agents can read it.
        </p>
        <FeedbackScreenshotField maxBytes={page.screenshot.maxBytes} maxSide={page.screenshot.maxSide} />
        <div style={styles.row}>
          <button type="submit" className="drobek-button" style={{ marginTop: 0 }} disabled={busy} data-testid="feedback-send">
            {busy ? 'Sending…' : 'Send note'}
          </button>
        </div>
      </Form>
      {result && !result.ok ? (
        <p className="drobek-error" role="alert" data-testid="feedback-error">
          {result.error}
        </p>
      ) : null}
      <p className="drobek-foot">Signed in as {page.email}.</p>
    </PlatformPage>
  );
}
