/**
 * /workspaces/:slug/apps/:appSlug/settings — the Settings tab (NSO-288):
 * who may open the app (public / password gate on the app hosts), where it
 * may be embedded (the CSP frame-ancestors override) and the danger zone
 * (delete). Editors and admins get the forms; a viewer reads the current
 * values only (the action refuses them with 403 anyway).
 */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.settings.server.js';
import { ActionError, AppPage, appStyles } from '../app-header.js';

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
          Choose which websites may embed this app. Enter their origins (protocol, domain and optional port), separated
          by spaces, for example <code style={s.mono}>https://intranet.example.com</code>.
          Use <code style={s.mono}>&apos;self&apos;</code> to allow the app&apos;s own origin.
          Leave empty to block other websites. Dashboard previews remain allowed.
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

      {canEdit ? (
        <section style={styles.section} data-testid="settings-danger">
          <h2 style={styles.h2}>Delete app</h2>
          <div style={styles.danger}>
            <p style={{ ...styles.hint, color: '#7f1d1d' }}>
              This removes the app from the dashboard and your agents. Its published, preview and saved-version links
              stop working immediately. Its identifier <code style={s.mono}>{header.slug}</code> stays reserved for{' '}
              {settings.slugReleaseDays} days, then becomes available to other apps.
              Type <code style={s.mono}>{header.slug}</code> to confirm deletion.
            </p>
            <Form method="post" style={styles.row}>
              <input type="hidden" name="intent" value="delete" />
              <input
                type="text"
                name="confirm"
                autoComplete="off"
                placeholder={header.slug}
                style={s.input}
                aria-label={`Type ${header.slug} to confirm deletion`}
                data-testid="delete-confirm-input"
              />
              <button type="submit" style={s.dangerButton} disabled={busy} data-testid="delete-button">
                Delete app
              </button>
            </Form>
          </div>
        </section>
      ) : null}
    </AppPage>
  );
}
