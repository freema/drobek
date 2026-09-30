/**
 * The checks an upstream call makes after its caller passed, shared by the
 * app-host route and a module job's `ctx.upstreams.fetch`: the upstream is registered in the app's
 * workspace, it is the record the assignment is bound to, and the app is on
 * its allow-list; an unbound (older) assignment is bound here.
 */
import { ModuleError, type DB, type HookApp, type Logger } from '@drobek/modules';
import { ProxyError, resolveUpstreamForForward, upstreamAllowsApp, type UpstreamRecord } from '@drobek/proxy';
import { dbErrorForLog } from '@drobek/db';
import { bindAssignment } from './binding.js';
import type { UpstreamAssignment } from './config.js';

/** 403: the app's config does not assign the upstream `name`. */
export function notAssigned(name: string): ModuleError {
  return new ModuleError(
    'forbidden',
    `This app may not call the upstream "${name}". Assign it with configure_module('proxy', { upstreams: { "${name}": { rules: { call: "user" } } } }) — the app owner confirms it.`,
    { details: { reason: 'upstream_not_assigned', upstream: name } }
  );
}

/** The registered upstream record `name` of the app's workspace that the assignment may call (else the ModuleError). */
export async function assignedUpstream(input: { db: DB; log: Logger; app: HookApp; name: string; assignment: UpstreamAssignment }): Promise<UpstreamRecord> {
  const { db, app, name, assignment } = input;
  const upstream = await resolveUpstreamForForward(app.workspaceId, name, db).catch((err: unknown) => {
    if (err instanceof ProxyError && err.code === 'not_found') {
      throw new ModuleError(
        'not_found',
        `No upstream "${name}" is registered in this app's workspace — a workspace admin registers it in the drobek dashboard (workspace → Upstreams).`,
        { details: { reason: 'upstream_not_registered', upstream: name } }
      );
    }
    throw err;
  });
  if (assignment.id !== undefined && assignment.id !== upstream.id) {
    throw new ModuleError(
      'forbidden',
      `The upstream "${name}" was deleted and registered again after a workspace admin confirmed it for this app, so it is a new upstream. Remove it from the proxy config and add it again — an admin confirms the new one.`,
      { details: { reason: 'upstream_replaced', upstream: name } }
    );
  }
  if (!upstreamAllowsApp(upstream, app.id)) {
    throw new ModuleError(
      'forbidden',
      `A workspace admin has not allowed this app to call the upstream "${name}". An admin confirms the assignment in the drobek dashboard — if it was assigned before the upstream was registered, remove it from the proxy config and add it again.`,
      { details: { reason: 'upstream_not_allowed', upstream: name } }
    );
  }
  if (assignment.id === undefined) {
    // An older (name-only) assignment: the app is on THIS record's allow-list,
    // so an admin confirmed this record — bind it (best effort, the call goes on).
    await bindAssignment(db, app.id, name, upstream.id, { onlyIfUnbound: true }).catch((err: unknown) =>
      input.log.warn('proxy binding not stored', { app_id: app.id, upstream: name, error: dbErrorForLog(err) })
    );
  }
  return upstream;
}
