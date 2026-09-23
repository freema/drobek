/**
 * Shared server glue for the owner's module tabs of an app (M2-03): Forms
 * (submissions), Users (end users), Uploads (files) — and the owner audit.
 *
 * Every tab resolves the app INSIDE the caller's workspace (another
 * workspace's app → 404) and then asks the module runtime for the ONE module
 * that owns that data, through its owner-facing authority (never another
 * module's tables): `submissions` (forms), `endUsers` (auth), `files`
 * (files). No such module on this server → `null`, and the tab renders a
 * "module not enabled" notice instead of failing.
 *
 * Role gating: loaders require viewer+, actions editor+
 * (requireWorkspaceRole), and every mutating request already passed the
 * dashboard origin check (the global CSRF middleware of the server).
 */
import { data } from 'react-router';
import { actorKindForSurface, writeAudit } from '@drobek/audit';
import { isModuleError, moduleRuntime, type BoundEndUsers, type BoundFiles, type BoundSubmissions, type HookApp } from '@drobek/modules';
import type { WorkspaceAccess } from '@drobek/tenancy';
import { loadAppForView } from './apps.server.js';

/** The app `appSlug` of the caller's workspace, or a 404. */
export async function ownerApp(access: WorkspaceAccess, appSlug: string): Promise<HookApp> {
  const app = await loadAppForView(access.workspace.id, appSlug);
  if (!app) throw data({ message: 'Not found' }, { status: 404 });
  return { id: app.id, slug: app.slug, workspaceId: access.workspace.id };
}

export async function submissionsOf(app: HookApp): Promise<BoundSubmissions | null> {
  return (await moduleRuntime()).submissions(app);
}

export async function endUsersOf(app: HookApp): Promise<BoundEndUsers | null> {
  return (await moduleRuntime()).endUsers(app);
}

export async function filesOf(app: HookApp): Promise<BoundFiles | null> {
  return (await moduleRuntime()).files(app);
}

/**
 * A module error → what the page shows (`{ status, message }`), with the
 * field details of a validation error appended. Anything that is not a
 * ModuleError is rethrown (a real 500).
 */
export function ownerError(err: unknown): { status: number; message: string } {
  if (!isModuleError(err)) throw err;
  let message = err.message;
  const details = err.details as unknown;
  const fields = Array.isArray(details)
    ? details
    : details && typeof details === 'object' && Array.isArray((details as { errors?: unknown }).errors)
      ? (details as { errors: unknown[] }).errors
      : [];
  const lines = fields
    .map((d) => (d && typeof d === 'object' ? `${String((d as { path?: unknown }).path ?? '') || 'record'}: ${String((d as { message?: unknown }).message ?? '')}` : ''))
    .filter(Boolean)
    .slice(0, 5);
  if (lines.length > 0 && !Array.isArray(details)) message = `${message} (${lines.join('; ')})`;
  else if (lines.length > 0) message = `${message}: ${lines.join('; ')}`;
  return { status: err.status, message };
}

/** Append the owner's audit row for an app (actor: the dashboard user). `meta` carries ids and counts only. */
export async function auditOwner(access: WorkspaceAccess, app: Pick<HookApp, 'slug'>, action: string, meta: Record<string, unknown>): Promise<void> {
  await writeAudit({
    workspaceId: access.workspace.id,
    actorUserId: access.user.id,
    actorKind: actorKindForSurface('web'),
    action,
    subjectType: 'app',
    target: app.slug,
    meta,
  });
}
