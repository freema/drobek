/**
 * /workspaces/:slug/apps/:appSlug/settings — the Settings tab (NSO-288):
 * who may open the app (public / password gate on the app hosts), where it
 * may be embedded (the CSP frame-ancestors override) and the danger zone
 * (delete). Editors and admins get the forms; a viewer reads the current
 * values only (the action refuses them with 403 anyway).
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.settings.server.js';
import { ActionError, AppHeader, appStyles } from '../app-header.js';

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
    marginTop: '0.75rem',
  },
} as const;

export default function AppSettingsRoute() {
  const { header, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const canEdit = header.canEdit;

  return (
    <main style={s.main}>
      <AppHeader header={header} />
      <ActionError actionData={actionData} />

      <section style={styles.section} data-testid="settings-visibility">
        <h2 style={styles.h2}>Visibility</h2>
        <p style={styles.hint}>
          Public apps open for anyone with the link. A password-protected app asks every visitor for the password on
          all its hosts (production, preview, versions) — members too.
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
          By default no site may embed the app in a frame. List the origins that may (e.g. your intranet), separated by
          spaces: <code style={s.mono}>&apos;self&apos;</code> or <code style={s.mono}>https://intranet.example.com</code>.
          Leave empty to forbid embedding.
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
                style={{ ...s.input, minWidth: '22rem' }}
                aria-label="Allowed frame ancestors"
                data-testid="frame-ancestors-input"
              />
              <button type="submit" style={s.button} disabled={busy} data-testid="frame-ancestors-save">
                Save embedding
              </button>
            </div>
          </Form>
        ) : null}
      </section>

      {canEdit ? (
        <section style={styles.section} data-testid="settings-danger">
          <h2 style={styles.h2}>Delete app</h2>
          <div style={styles.danger}>
            <p style={{ ...styles.hint, color: '#7f1d1d' }}>
              The app disappears from the dashboard and from your agents, and all its addresses answer 404 at once. Its
              address <code style={s.mono}>{header.slug}</code> stays reserved for {settings.slugReleaseDays} days, then
              anyone can take it. Type the address to confirm.
            </p>
            <Form method="post" style={styles.row}>
              <input type="hidden" name="intent" value="delete" />
              <input
                type="text"
                name="confirm"
                autoComplete="off"
                placeholder={header.slug}
                style={s.input}
                aria-label="Type the app's address to confirm"
                data-testid="delete-confirm-input"
              />
              <button type="submit" style={s.dangerButton} disabled={busy} data-testid="delete-button">
                Delete app
              </button>
            </Form>
          </div>
        </section>
      ) : null}
    </main>
  );
}
