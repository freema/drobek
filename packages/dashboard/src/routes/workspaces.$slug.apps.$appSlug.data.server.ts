/**
 * GET /workspaces/:slug/apps/:appSlug/data — server half. The app's declared
 * COLLECTIONS for the Data tab: name, stored records, rules and a short schema
 * summary. viewer+ (the owner's view through the data module's records
 * authority — the end-user rules do not apply to workspace members). Unknown
 * slug / non-member → 404 (requireWorkspaceRole); an app of another workspace
 * → 404 (recordsOf).
 */
import { type LoaderFunctionArgs } from 'react-router';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { rulesText, schemaSummary } from '../data-view.js';
import { recordsOf, withDataErrors } from './data-http.server.js';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(request, String(params.slug ?? ''), 'viewer');
  const appSlug = String(params.appSlug ?? '');
  const records = await recordsOf(access.workspace.id, appSlug);
  const collections = await withDataErrors(() => records.collections());

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    appSlug,
    collections: collections.map((c) => ({
      name: c.name,
      recordCount: c.records,
      rules: rulesText(c.rules),
      schemaSummary: schemaSummary(c.columns),
    })),
    role: access.effectiveRole,
  };
}
