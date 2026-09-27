/**
 * /workspaces/:slug/apps/:appSlug/settings — the Settings tab (NSO-288):
 * who may open the app (public / password gate on the app hosts), where it
 * may be embedded (the CSP frame-ancestors override, and what it does not
 * cover), where the public gallery listing lives (Overview, NSO-340) and the
 * danger zone (delete). Editors and admins get the forms; a viewer reads the current
 * values only (the action refuses them with 403 anyway).
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.settings.server.js';
import { ActionError, AppPage, appStyles } from '../app-header.js';
import { galleryStatus } from '../gallery-section.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Settings — ${data?.header.name ?? data?.header.slug ?? 'App'} — drobek` }];
}

const s = appStyles;

const styles = {
  section: { marginTop: '1.75rem' },
  h2: { fontSize: '1.1rem', margin: '0 0 0.35rem' },
  hint: { color: '#555', fontSize: '0.9rem', margin: '0 0 0.6rem' },
  row: { display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', margin: '0.4rem 0' },
  radio: { display: 'inline-flex', gap: '0.35rem', alignItems: 'center', fontSize: '0.92rem' },
  danger: {
    border: '1px solid #fecaca',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    background: '#fff7f7',
    overflowWrap: 'anywhere',
    marginTop: '0.75rem',
  },
} as const;

export default function AppSettingsRoute() {
  const { header, settings, gallery } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const canEdit = header.canEdit;
  const galleryHref = `${header.basePath}#gallery`;
  const galleryNow = gallery ? galleryStatus(gallery) : null;

  return (
    <AppPage header={header}>
      <ActionError actionData={actionData} />

      <section style={styles.section} data-testid="settings-visibility">
        <h2 style={styles.h2}>Visibility</h2>
        <p style={styles.hint}>
          Anyone with the link can open a public app. Password protection applies to the published app, preview and
          saved versions, including visits by workspace members.
        </p>
        <p style={s.inline}>
          Now: <strong data-testid="settings-visibility-current">{settings.visibility}</strong>
          {settings.visibility === 'password' && settings.hasPassword ? (
            <span style={s.muted}>(a password is set)</span>
          ) : null}
        </p>
        {canEdit ? (
          <Form method="post" data-testid="visibility-form" style={s.panel}>
            <input type="hidden" name="intent" value="visibility" />
            <div style={styles.row}>
              <label style={styles.radio}>
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  defaultChecked={settings.visibility === 'public'}
                  data-testid="visibility-public"
                />
                Public
              </label>
              <label style={styles.radio}>
                <input
                  type="radio"
                  name="visibility"
                  value="password"
                  defaultChecked={settings.visibility === 'password'}
                  data-testid="visibility-password"
                />
                Password
              </label>
            </div>
            <div style={styles.row}>
              <label htmlFor="app-password" style={s.label}>
                {settings.hasPassword ? 'New password (optional)' : 'Password'}
              </label>
              <input
                id="app-password"
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={settings.passwordMin}
                maxLength={settings.passwordMax}
                style={s.input}
                data-testid="password-input"
              />
            </div>
            <button type="submit" style={s.button} disabled={busy} data-testid="visibility-save">
              Save visibility
            </button>
          </Form>
        ) : null}
      </section>

      <section style={styles.section} data-testid="settings-frame-ancestors">
        <h2 style={styles.h2}>Embedding</h2>
        <p style={styles.hint}>
          Choose which other websites may show this app in a frame. Enter their origins (protocol, domain and optional
          port), separated by spaces, for example <code style={s.mono}>https://intranet.example.com</code>.
          Use <code style={s.mono}>&apos;self&apos;</code> to allow the app&apos;s own origin.
          Leave it empty to block every other website.
        </p>
        <p style={styles.hint} data-testid="embedding-exceptions">
          This list does not change what drobek itself shows: the dashboard always shows the small preview in your
          workspace&apos;s app list
          {gallery?.previews ? (
            <>
              , and while the app is shown in the public gallery, the gallery website may show a live preview of its
              production address (never of the preview or saved versions). To stop that, remove the app from the gallery
              on the <Link to={galleryHref}>Overview tab</Link>
            </>
          ) : null}
          .
        </p>
        <p style={s.inline}>
          Now:{' '}
          <code style={s.mono} data-testid="settings-frame-ancestors-current">
            {settings.frameAncestors ?? "'none'"}
          </code>
        </p>
        {canEdit ? (
          <Form method="post" data-testid="frame-ancestors-form" style={s.panel}>
            <input type="hidden" name="intent" value="frame-ancestors" />
            <div style={styles.row}>
              <input
                type="text"
                name="frameAncestors"
                defaultValue={settings.frameAncestors ?? ''}
                placeholder="https://intranet.example.com"
                style={{ ...s.input, flex: '1 1 18rem', minWidth: 'min(18rem, 100%)' }}
                aria-label="Websites allowed to embed this app"
                data-testid="frame-ancestors-input"
              />
              <button type="submit" style={s.button} disabled={busy} data-testid="frame-ancestors-save">
                Save embedding
              </button>
            </div>
          </Form>
        ) : null}
      </section>

      {gallery ? (
        <section style={styles.section} data-testid="settings-gallery">
          <h2 style={styles.h2}>Public gallery</h2>
          <p style={styles.hint}>
            Showing the app in this server&apos;s public gallery, its public description and whether others may
            duplicate it are set in the Gallery section of the Overview tab, next to the versions you publish. Only a
            published, public app is shown there.
          </p>
          <p style={s.inline}>
            Now:{' '}
            <strong data-testid="settings-gallery-status" data-state={galleryNow?.state}>
              {galleryNow?.text}
            </strong>
            <Link to={galleryHref} data-testid="settings-gallery-link">
              Open the gallery settings
            </Link>
          </p>
        </section>
      ) : null}

      {canEdit ? (
        <section style={styles.section} data-testid="settings-danger">
          <h2 style={styles.h2}>Delete app</h2>
          <div style={styles.danger}>
            <p style={{ ...styles.hint, color: '#7f1d1d', margin: 0 }}>
              You are deleting <strong>{header.name || header.slug}</strong> (identifier <code style={s.mono}>{header.slug}</code>). Deleting it:
            </p>
            <ul style={{ ...styles.hint, color: '#7f1d1d', margin: '0.4rem 0 0.9rem', paddingLeft: '1.2rem' }}>
              <li>removes it from the dashboard and from your agents;</li>
              <li>stops its published, preview and saved-version links immediately;</li>
              <li>
                keeps <code style={s.mono}>{header.slug}</code> reserved for {settings.slugReleaseDays} days, then lets other apps take it.
              </li>
            </ul>
            <Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <label htmlFor="delete-confirm" style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem', color: '#7f1d1d', marginBottom: '0.3rem' }}>
                To confirm, type the identifier <code style={s.mono}>{header.slug}</code>
              </label>
              <div style={styles.row}>
                <input
                  id="delete-confirm"
                  type="text"
                  name="confirm"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  style={{ ...s.input, flex: '1 1 16rem', minWidth: 'min(16rem, 100%)' }}
                  data-testid="delete-confirm-input"
                />
                <button type="submit" style={s.dangerButton} disabled={busy} data-testid="delete-button">
                  Delete this app
                </button>
              </div>
            </Form>
          </div>
        </section>
      ) : null}
    </AppPage>
  );
}
