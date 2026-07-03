/**
 * Pure rollback-target selection (U6, PHY-57). Rollback = repoint
 * `apps.active_deploy_id` at a prior READY deploy. This decides WHICH deploy,
 * given the app's deploy history + the currently active pointer.
 */
import type { DeployState } from './types.js';

export interface RollbackCandidate {
  id: string;
  state: DeployState;
  /** unix ms — creation order. */
  createdAt: number;
  /** unix ms of last activation, or null if never activated. */
  activatedAt: number | null;
}

export type RollbackChoice =
  | { ok: true; deployId: string }
  | { ok: false };

/**
 * - explicit `toDeployId` → that deploy, but only if it is a READY deploy of
 *   this app;
 * - otherwise → the most-recently-activated READY deploy that is NOT the
 *   current active one (i.e. the previous good version).
 */
export function chooseRollbackTarget(
  candidates: RollbackCandidate[],
  currentActiveId: string | null,
  toDeployId?: string
): RollbackChoice {
  const ready = candidates.filter((c) => c.state === 'ready');

  if (toDeployId) {
    const target = ready.find((c) => c.id === toDeployId);
    return target ? { ok: true, deployId: target.id } : { ok: false };
  }

  const sorted = [...ready].sort(
    (a, b) => (b.activatedAt ?? b.createdAt) - (a.activatedAt ?? a.createdAt)
  );
  const prior = sorted.find((c) => c.id !== currentActiveId);
  return prior ? { ok: true, deployId: prior.id } : { ok: false };
}
