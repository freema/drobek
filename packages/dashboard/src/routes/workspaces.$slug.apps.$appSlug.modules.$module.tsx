/**
 * /workspaces/:slug/apps/:appSlug/modules/:module — client half (M2-02,
 * NSO-291), the page configure_module's `confirm_url` points at: the pending
 * change (diff, risk notes, Confirm / Reject), the config form generated from
 * the module's JSON Schema, the dedicated editor the module declares
 * (`dashboard.editor`: collections / upstreams), the write-only secrets and
 * "About this module" (version, source, contract, slots, contributions, its
 * own error codes — NSO-347). Viewers see the same page without controls.
 * Server code lives in the .server.ts; values arrive pre-shaped and
 * secret-free.
 */
import { Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { action, loader } from './workspaces.$slug.apps.$appSlug.modules.$module.server.js';
import { AppPage } from '../app-header.js';
import { PendingBanner } from '../pending-banner.js';
import { JsonSchemaForm } from '../module-ui/json-schema-form.js';
import { ContributesTable, ErrorsTable, ModuleFactsList, SlotsTable } from '../module-ui/module-facts.js';
import { PendingPanel } from '../module-ui/pending-panel.js';
import { CollectionsEditor, UpstreamsEditor } from '../module-ui/rules-editors.js';
import { SecretsForm } from '../module-ui/secrets-form.js';
import { ui } from '../module-ui/styles.js';

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  return [{ title: `${data?.module.name ?? 'Module'} — ${data?.app.slug ?? 'App'} — drobek` }];
}

const DONE: Record<string, string> = {
  applied: 'Saved — the new configuration is in force.',
  pending: 'Saved as a change awaiting confirmation — it applies once confirmed.',
  unchanged: 'Nothing changed.',
  confirmed: 'Confirmed — the change is in force.',
  rejected: 'Rejected — the configuration stays as it was.',
  'secret-set': 'Secret stored.',
  'secret-rotated': 'Secret rotated — the new value is in use from the next request.',
  'secret-removed': 'Secret removed.',
};

const COLLECTION_INTENTS = new Set(['add-collection', 'save-collection', 'remove-collection']);
const UPSTREAM_INTENTS = new Set(['save-upstream', 'unassign-upstream']);

export default function AppModuleRoute() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const errors = actionData && 'errors' in actionData ? actionData.errors : null;
  const configErrors = errors?.intent === 'save-config' ? errors : null;
  const configValues = configErrors?.values ?? d.values;
  const decisionErrors = errors && (errors.intent === 'confirm' || errors.intent === 'reject') ? errors.general : [];
  const secretError =
    errors && (errors.intent === 'set-secret' || errors.intent === 'remove-secret') ? { target: errors.target, messages: errors.general } : null;

  return (
    <AppPage header={d.header} trail={[{ label: d.module.name }]}>
      <h2 style={ui.title}>
        {d.module.name} <span style={{ ...ui.small, fontWeight: 400 }}>v{d.module.version}</span>
      </h2>
      <p style={ui.hint}>Use when {d.module.useWhen}</p>
      {!d.canEdit ? (
        <p style={ui.small} data-testid="readonly-note">
          You can view this module’s configuration; changing it needs the editor role.
        </p>
      ) : null}

      <PendingBanner banner={d.banner} />
      {d.done && DONE[d.done] ? (
        <div style={ui.notice} role="status" data-testid="done-notice" data-done={d.done}>
          {DONE[d.done]}
        </div>
      ) : null}

      {decisionErrors.length > 0 ? (
        <div style={ui.error} role="alert" data-testid="decision-error">
          {decisionErrors.join(' ')}
        </div>
      ) : null}
      <PendingPanel pending={d.pending} canEdit={d.canEdit} busy={busy} />

      {d.fields.length > 0 ? (
        <section id="config" aria-label="Configuration">
          <h2 style={ui.h2}>Configuration</h2>
          {d.module.confirms ? (
            <p style={ui.hint}>Some changes (those that widen access or send mail somewhere new) wait for confirmation after saving.</p>
          ) : null}
          {configErrors && configErrors.general.length > 0 ? (
            <div style={ui.error} role="alert" data-testid="config-errors">
              {configErrors.general.join(' ')}
            </div>
          ) : null}
          <JsonSchemaForm
            key={JSON.stringify(configValues)}
            fields={d.fields}
            values={configValues}
            errors={configErrors?.fields}
            readOnly={!d.canEdit}
            busy={busy}
          />
        </section>
      ) : null}

      {d.editor === 'collections' ? (
        <section aria-label="Collections and rules">
          <h2 style={ui.h2}>Collections &amp; rules</h2>
          <CollectionsEditor
            collections={d.collections}
            ops={d.ops}
            canEdit={d.canEdit}
            busy={busy}
            error={errors && COLLECTION_INTENTS.has(errors.intent) ? errors : null}
          />
        </section>
      ) : null}

      {d.editor === 'upstreams' ? (
        <section aria-label="Upstreams">
          <h2 style={ui.h2}>Upstreams for this app</h2>
          <UpstreamsEditor
            upstreams={d.upstreams}
            workspaceSlug={d.workspace.slug}
            canEdit={d.canEdit}
            busy={busy}
            error={errors && UPSTREAM_INTENTS.has(errors.intent) ? errors : null}
          />
        </section>
      ) : null}

      {d.secrets.length > 0 ? (
        <section aria-label="Secrets">
          <h2 style={ui.h2}>Secrets</h2>
          <SecretsForm secrets={d.secrets} canEdit={d.canEdit} busy={busy} error={secretError} />
        </section>
      ) : null}

      {d.fields.length === 0 && !d.editor && d.secrets.length === 0 ? (
        <p style={ui.muted}>This module has nothing to configure.</p>
      ) : null}

      <section id="about" aria-label="About this module" data-testid="module-about">
        <h2 style={ui.h2}>About this module</h2>
        <ModuleFactsList facts={d.about} />
        <SlotsTable slots={d.about.slots} />
        <ContributesTable contributes={d.about.contributes} />
        <p style={ui.small}>
          <Link to={d.modulesHref} data-testid="workspace-modules-link">
            Every module of this server
          </Link>{' '}
          — versions, slots, limits for this workspace.
        </p>
      </section>

      <section id="errors" aria-label="Error codes">
        <h2 style={ui.h2}>Error codes</h2>
        <p style={ui.hint}>What this module’s routes may answer besides the core codes — the app’s code and the agent see these.</p>
        <ErrorsTable errors={d.errors} />
      </section>
    </AppPage>
  );
}
