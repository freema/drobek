/**
 * /duplicate/:slug — client half (NSO-340): the confirm page behind the
 * gallery's Duplicate button. It names the app and its author's workspace,
 * says what the copy gets and what stays behind, and asks for the target
 * workspace and a name; or explains why this app cannot be duplicated.
 */
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { DashboardPage, controls, mergeStyles } from '@drobek/tenancy/layout';
import type { action, loader } from './duplicate.$slug.server.js';

export function meta() {
  return [{ title: 'Duplicate an app — drobek' }, { name: 'robots', content: 'noindex' }];
}

const styles = {
  h1: { fontSize: '1.75rem', marginBottom: '0.25rem' },
  h2: { fontSize: '1.05rem', margin: '1.5rem 0 0.4rem' },
  hint: { color: '#555', marginTop: 0, fontSize: '0.95rem' },
  list: { margin: '0.2rem 0 0', paddingLeft: '1.2rem', fontSize: '0.92rem' },
  card: {
    margin: '1.25rem 0',
    padding: '0.9rem 1rem',
    border: '1px solid #e4e4e7',
    borderRadius: '10px',
  },
  error: {
    margin: '1rem 0',
    padding: '0.6rem 0.9rem',
    border: '1px solid #fca5a5',
    background: '#fef2f2',
    color: '#991b1b',
    borderRadius: '8px',
  },
  notice: {
    margin: '1rem 0',
    padding: '0.9rem 1rem',
    border: '1px solid #fde68a',
    background: '#fffbeb',
    color: '#78350f',
    borderRadius: '10px',
  },
} as const;

const REFUSAL_TITLE = {
  not_found: 'This app is not in the gallery',
  not_duplicable: 'This app cannot be duplicated',
  gallery_disabled: 'This server has no public gallery',
} as const;

export default function DuplicateRoute() {
  const page = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';

  if (page.refused !== null) {
    return (
      <DashboardPage crumbs={[{ label: 'Duplicate an app' }]}>
        <h1 style={styles.h1}>{REFUSAL_TITLE[page.refused]}</h1>
        <p style={styles.notice} role="status" data-testid="duplicate-refused" data-reason={page.refused}>
          {page.message} Only apps shown in the public gallery whose owner allows duplicates can be copied.
        </p>
        <p>
          <Link to="/workspaces" style={controls.link}>
            Go to your workspaces
          </Link>
        </p>
      </DashboardPage>
    );
  }

  const { source, workspaces, defaultName, nameMax } = page;
  return (
    <DashboardPage crumbs={[{ label: 'Duplicate an app' }]}>
      <h1 style={styles.h1}>Duplicate “{source.name}”</h1>
      <p style={styles.hint}>
        By {source.workspaceName}. {source.description}
      </p>

      <section style={styles.card} data-testid="duplicate-what">
        <h2 style={{ ...styles.h2, marginTop: 0 }}>What the copy gets</h2>
        <ul style={styles.list}>
          <li>The files of the published version, as version 1 of a new, unpublished app in the workspace you pick.</li>
          <li>
            The module settings{source.modules.length > 0 ? ` (${source.modules.join(', ')})` : ''}, proposed to the
            new app: anything that needs a confirmation (for example public access) waits for you on the new app’s
            Modules page.
          </li>
        </ul>
        <h2 style={styles.h2}>What stays with the original</h2>
        <ul style={styles.list}>
          <li>Its data, end users, form submissions, uploads and app assets (images, fonts).</li>
          <li>Secrets and API keys, proxy upstreams, and e-mail addresses in its settings.</li>
          <li>Its custom domains, its gallery listing and its version history.</li>
        </ul>
        <p style={{ ...styles.hint, margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
          The new app remembers that it was duplicated from {source.slug}. The original’s owner sees only that a copy
          was made, not who made it.
        </p>
      </section>

      {result?.error ? (
        <p style={styles.error} role="alert" data-testid="duplicate-error">
          {result.error}
        </p>
      ) : null}

      {workspaces.length === 0 ? (
        <p style={styles.notice} role="status" data-testid="duplicate-no-workspace">
          You are not an editor in any workspace, so there is nowhere to put the copy. Ask a workspace admin to make
          you an editor.
        </p>
      ) : (
        <Form method="post" data-testid="duplicate-form">
          <div style={controls.row}>
            <label style={controls.field}>
              <span style={controls.label}>Workspace</span>
              <select name="workspace" defaultValue={workspaces[0].slug} style={controls.select} data-testid="duplicate-workspace">
                {workspaces.map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.personal ? `${w.name} (personal)` : w.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={mergeStyles(controls.field, { flex: '1 1 16rem' })}>
              <span style={controls.label}>Name</span>
              <input
                name="name"
                defaultValue={defaultName}
                maxLength={nameMax}
                style={mergeStyles(controls.input, { width: '100%' })}
                data-testid="duplicate-name"
              />
            </label>
            <button type="submit" style={controls.button} disabled={busy} data-testid="duplicate-submit">
              Duplicate
            </button>
          </div>
        </Form>
      )}
    </DashboardPage>
  );
}
