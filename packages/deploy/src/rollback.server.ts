/**
 * rollback (U6, PHY-57): repoint apps.active_deploy_id at a prior READY deploy
 * (or an explicit target). Deploys are immutable — rollback is a pointer flip,
 * never a rebuild — and is audited.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { apps, deploys, getDb } from '@drobek/db';
import { bustServeCache } from '@drobek/serving/cache';
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy';
import {
  writeAudit,
  AUDIT_ACTIONS,
  AUDIT_SUBJECT_TYPES,
  type AuditActorKind,
} from './audit.server.js';
import { DeployError } from './errors.js';
import { chooseRollbackTarget } from './rollback-target.js';
import { loadAppBySlug } from './store.server.js';
import type { DeployState } from './types.js';

// Re-export the actor helper on the /rollback subpath so the dashboard rollback
// action (which imports rollback here to stay bullmq-free) can resolve its
// actor_kind without pulling the @drobek/deploy barrel.
export { actorKindForSurface, type AuditActorKind } from './audit.server.js';

export interface RollbackInput {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  /** agent (MCP tool) vs user (dashboard) — server-derived at the call site. */
  actorKind: AuditActorKind;
  slug: string;
  toDeployId?: string;
}

export interface RollbackResult {
  restoredDeployId: string;
  appSlug: string;
}

export async function rollback(input: RollbackInput): Promise<RollbackResult> {
  if (!roleAtLeast(input.role, 'editor')) {
    throw new DeployError('forbidden', 'rollback requires an editor or workspace-admin role');
  }

  const app = await loadAppBySlug(input.workspaceId, input.slug);
  if (!app) {
    throw new DeployError('not_found', `no app "${input.slug}" in this workspace`);
  }

  const rows = await getDb()
    .select({
      id: deploys.id,
      state: deploys.state,
      createdAt: deploys.createdAt,
      activatedAt: deploys.activatedAt,
    })
    .from(deploys)
    .where(and(eq(deploys.appId, app.id), isNull(deploys.deletedAt)));

  const chosen = chooseRollbackTarget(
    rows.map((r) => ({
      id: r.id,
      state: r.state as DeployState,
      createdAt: r.createdAt.getTime(),
      activatedAt: r.activatedAt ? r.activatedAt.getTime() : null,
    })),
    app.activeDeployId,
    input.toDeployId
  );
  if (!chosen.ok) {
    throw new DeployError('no_rollback_target', 'no prior ready deploy to roll back to');
  }

  await getDb()
    .update(apps)
    .set({ activeDeployId: chosen.deployId })
    .where(eq(apps.id, app.id));

  // U7: the active pointer moved — bust the serving cache so the rolled-back
  // version is served immediately (not up to the pointer TTL later).
  await bustServeCache({ workspaceId: input.workspaceId, appSlug: input.slug });

  await writeAudit({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    actorKind: input.actorKind,
    action: AUDIT_ACTIONS.deployRollback,
    subjectType: AUDIT_SUBJECT_TYPES.app,
    target: input.slug,
    meta: { toDeployId: chosen.deployId, fromDeployId: app.activeDeployId },
  });

  return { restoredDeployId: chosen.deployId, appSlug: input.slug };
}
