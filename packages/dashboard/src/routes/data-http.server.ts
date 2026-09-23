/**
 * Shared server glue for the Data-tab routes. The Data tab is the app
 * OWNER's view of the records the app's data module stores: it resolves the
 * app inside the caller's workspace (another workspace's app → 404) and asks
 * the module runtime's records authority (the built-in `data` module), which
 * is scoped to that one app. No data module on this server → 404.
 *
 * `withDataErrors` maps a module `not_found` → 404 and `invalid_request` →
 * 400 (the react-router `data(...)` throw the dashboard uses elsewhere).
 */
import { data } from 'react-router';
import { isModuleError, moduleRuntime, type BoundRecords } from '@drobek/modules';
import { loadAppForView } from '../apps.server.js';

export async function recordsOf(workspaceId: string, appSlug: string): Promise<BoundRecords> {
  const app = await loadAppForView(workspaceId, appSlug);
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  const records = await (await moduleRuntime()).records({ id: app.id, slug: app.slug, workspaceId });
  if (!records) throw data({ message: 'The data module is not enabled on this server.' }, { status: 404 });
  return records;
}

export async function withDataErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isModuleError(err)) {
      if (err.code === 'not_found') throw data({ message: 'Not found' }, { status: 404 });
      if (err.code === 'invalid_request') throw data({ message: err.message }, { status: 400 });
    }
    throw err;
  }
}
