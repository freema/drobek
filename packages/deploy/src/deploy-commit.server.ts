/**
 * deploy_commit (U6, PHY-57): verify EVERY manifest blob is now stored, then
 * enqueue the BullMQ job and flip the deploy to `queued`. Ownership + role are
 * re-checked (the deploy's app must live in the caller's bound workspace).
 */
import { eq } from 'drizzle-orm';
import { deploys, getDb } from '@drobek/db';
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy';
import { type AuditActorKind } from './audit.server.js';
import { DeployError } from './errors.js';
import { enqueueDeploy } from './queue.server.js';
import { loadAppRow, loadDeployRow, presentShas } from './store.server.js';
import type { DeployState } from './types.js';

export interface DeployCommitInput {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  /** agent (MCP tool) vs user — threaded to the worker's deploy.activate audit. */
  actorKind: AuditActorKind;
  deployId: string;
}

export interface DeployCommitResult {
  deployId: string;
  state: DeployState;
}

export async function deployCommit(
  input: DeployCommitInput
): Promise<DeployCommitResult> {
  if (!roleAtLeast(input.role, 'editor')) {
    throw new DeployError('forbidden', 'committing a deploy requires an editor or workspace-admin role');
  }

  const deploy = await loadDeployRow(input.deployId);
  if (!deploy) throw new DeployError('not_found', 'deploy not found');

  const app = await loadAppRow(deploy.appId);
  if (!app || app.workspaceId !== input.workspaceId) {
    // Anti-enumeration: a deploy in another workspace is simply "not found".
    throw new DeployError('not_found', 'deploy not found');
  }

  if (deploy.state !== 'awaiting_upload') {
    throw new DeployError(
      'invalid_state',
      `deploy cannot be committed from state "${deploy.state}" (expected awaiting_upload)`
    );
  }

  // ALL manifest blobs must be present (the client cannot commit a deploy whose
  // bytes were never uploaded).
  const present = await presentShas(deploy.manifest.map((e) => e.sha256));
  const missing = deploy.manifest.filter((e) => !present.has(e.sha256));
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).map((m) => m.path).join(', ');
    throw new DeployError(
      'missing_blobs',
      `${missing.length} file(s) were not uploaded: ${sample}`
    );
  }

  await getDb()
    .update(deploys)
    .set({ state: 'queued', error: null })
    .where(eq(deploys.id, input.deployId));

  // Thread the committing actor to the worker so the async deploy.activate audit
  // is attributed correctly (server-derived; the client cannot set actor_kind).
  await enqueueDeploy(input.deployId, {
    actorUserId: input.userId,
    actorKind: input.actorKind,
  });

  return { deployId: input.deployId, state: 'queued' };
}
