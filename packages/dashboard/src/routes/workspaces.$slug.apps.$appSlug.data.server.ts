/**
 * GET/POST /workspaces/:slug/apps/:appSlug/data — server half. The app's declared
 * COLLECTIONS for the Data tab: name, stored records, rules and a short schema
 * summary. viewer+ (the owner's view through the data module's records
 * authority — the end-user rules do not apply to workspace members). Unknown
 * slug / non-member → 404 (requireWorkspaceRole); an app of another workspace
 * → 404 (recordsOf).
 *
 * It also lists ORPHANS (NSO-324): records of collections the config no
 * longer declares (e.g. a write that landed while its collection was being
 * removed) — invisible everywhere else, yet counted by the app's quota.
 * POST `purge-orphan` (editor+, requireWorkspaceRole gates it server-side
 * before anything changes) deletes them after the owner typed the name;
 * audited `data.collection.purge` (meta: collection, records, orphan).
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { isModuleError } from '@drobek/modules';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { rulesText, schemaSummary } from '../data-view.js';
import { recordsOf, withDataErrors } from './data-http.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const appSlug = String(params.appSlug ?? '');
  const records = await recordsOf(access.workspace.id, appSlug);
  const collections = await withDataErrors(() => records.collections());
  const orphans = await withDataErrors(() => records.orphans());
  const search = new URL(request.url).searchParams;

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug,
    collections: collections.map((c) => ({
      name: c.name,
      recordCount: c.records,
      rules: rulesText(c.rules),
      schemaSummary: schemaSummary(c.columns),
    })),
    orphans,
    canPurge: access.effectiveRole !== 'viewer',
    role: access.effectiveRole,
    /** A collection the owner just deleted (the notice after the redirect). */
    dropped: (search.get('dropped') ?? '').slice(0, 64),
    /** An orphan collection the owner just purged. */
    purged: (search.get('purged') ?? '').slice(0, 64),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Editor GATE (server-side): viewer → 403, non-member → 404 — before anything changes.
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'editor');
  const appSlug = String(params.appSlug ?? '');
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  if (intent !== 'purge-orphan') return data({ intent, error: 'Unsupported action.' }, { status: 400 });
  const collection = String(form.get('collection') ?? '').trim();
  const typed = String(form.get('confirm_name') ?? '').trim();
  if (!collection || typed !== collection) {
    return data({ intent, collection, error: `Type the collection name "${collection}" to purge its records.` }, { status: 400 });
  }
  const records = await recordsOf(access.workspace.id, appSlug);
  try {
    await records.purgeOrphan(collection, access.user.id);
  } catch (err) {
    if (!isModuleError(err)) throw err;
    return data({ intent, collection, error: err.message }, { status: err.status });
  }
  return redirect(`/workspaces/${access.workspace.slug}/apps/${appSlug}/data?purged=${encodeURIComponent(collection)}`);
}
