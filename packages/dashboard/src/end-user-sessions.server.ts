/**
 * "Sign everyone out" of an app (M1-02, PHY-76 #9) — ONE implementation for
 * the owner's API (`POST /api/apps/:id/end-user-sessions/revoke`) and the
 * dashboard Users tab (M2-03): the app's session epoch goes up, so every
 * `drobek_eu` session issued before stops resolving on every host of the app
 * (preview, production, version hosts) from the next request. Audit
 * `end_users.sessions_revoke` (actor user). The caller authorized an editor+
 * of the app's workspace first.
 */
import { AUDIT_ACTIONS, actorKindForSurface, writeAudit } from '@drobek/audit';
import { getRedis } from '@drobek/core';
import { revokeEndUserSessions } from '@drobek/modules';

export async function revokeAllEndUserSessions(app: { id: string; slug: string; workspaceId: string }, userId: string): Promise<number> {
  const epoch = await revokeEndUserSessions(getRedis(), app.id);
  await writeAudit({
    workspaceId: app.workspaceId,
    actorUserId: userId,
    actorKind: actorKindForSurface('web'),
    action: AUDIT_ACTIONS.endUserSessionsRevoke,
    subjectType: 'app',
    target: app.slug,
    meta: { epoch },
  });
  return epoch;
}
