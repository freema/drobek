/**
 * /workspaces/:slug/apps/:appSlug/modules — client half (M2-02, NSO-291):
 * the app's Modules tab — every platform module on the server, whether this
 * app configured it, what waits for confirmation and which required secrets
 * are missing; each links to its page. Server code lives in the .server.ts.
 */
import { Link, useLoaderData } from 'react-router';
import type { loader } from './workspaces.$slug.apps.$appSlug.modules.server.js';
import { AppPage } from '../app-header.js';
import { PendingBanner } from '../pending-banner.js';
import { ui } from '../module-ui/styles.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `Modules — ${data?.app.slug ?? 'App'} — drobek` }];
}

export default function AppModulesRoute() {
  const { workspace, app, header, modules, banner } = useLoaderData<typeof loader>();
  const base = `/workspaces/${workspace.slug}/apps/${app.slug}`;

  return (
    <AppPage header={header}>
      <h2 style={ui.title}>Modules</h2>
      <p style={ui.hint}>
        The backend features this server offers your app. Your agent configures them; changes that widen access wait here for your
        confirmation, and secrets are entered only here.
      </p>
      <PendingBanner banner={banner} />

      {modules.length === 0 ? (
        <p style={ui.muted}>This server runs no platform modules.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0' }} data-testid="modules-list">
          {modules.map((m) => (
            <li key={m.name} style={ui.panel} data-testid="module-row" data-module={m.name}>
              <div style={ui.row}>
                <Link to={`${base}/modules/${m.name}`} style={{ fontWeight: 700, color: '#1a1a1a' }} data-testid={`module-link-${m.name}`}>
                  {m.name}
                </Link>
                <span style={ui.small}>v{m.version}</span>
                {!m.enabled ? (
                  <span style={ui.badge} data-testid="module-not-enabled">
                    not enabled for this workspace
                  </span>
                ) : m.configured ? (
                  <span style={ui.okBadge}>configured</span>
                ) : (
                  <span style={ui.badge}>defaults</span>
                )}
                {m.pending.length > 0 ? (
                  <span style={ui.warnBadge} data-testid="module-pending">
                    {m.pending.length} awaiting confirmation
                  </span>
                ) : null}
                {m.secretsMissing.length > 0 ? (
                  <span style={ui.warnBadge} data-testid="module-secrets-missing">
                    secret missing: {m.secretsMissing.join(', ')}
                  </span>
                ) : m.secretsDeclared > 0 ? (
                  <span style={ui.small}>
                    secrets {m.secretsSet}/{m.secretsDeclared} set
                  </span>
                ) : null}
              </div>
              <p style={{ ...ui.small, margin: '0.3rem 0 0' }}>Use when {m.useWhen}</p>
            </li>
          ))}
        </ul>
      )}
    </AppPage>
  );
}
