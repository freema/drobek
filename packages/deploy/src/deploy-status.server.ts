/**
 * deploy_status (U6, PHY-57): the current pipeline state for a deploy, from the
 * deploy row (+ its app pointer). Readable by any workspace member (viewer+);
 * membership is re-checked at the tool layer. The workspace binding is enforced
 * here (anti-enumeration: a deploy in another workspace is "not found").
 */
import { appUrl } from './constants.js';
import { DeployError } from './errors.js';
import { loadDeployView } from './events.js';
import type { WorkspaceRole } from '@drobek/tenancy';
import type { DeployState } from './types.js';

export interface DeployStatusInput {
  userId: string;
  workspaceId: string;
  /** Reserved — reads are open to viewer+, gated at the tool layer. */
  role: WorkspaceRole;
  deployId: string;
}

export interface DeployStatusResult {
  deployId: string;
  state: DeployState;
  appSlug: string;
  url: string;
  /** True when this deploy is the app's currently-served version. */
  active: boolean;
  lintReport?: unknown;
  error?: string;
}

export async function deployStatus(
  input: DeployStatusInput
): Promise<DeployStatusResult> {
  const view = await loadDeployView(input.deployId);
  if (!view || view.workspaceId !== input.workspaceId) {
    throw new DeployError('not_found', 'deploy not found');
  }
  return {
    deployId: view.deployId,
    state: view.state,
    appSlug: view.appSlug,
    url: appUrl(view.workspaceSlug, view.appSlug),
    active: view.active,
    lintReport: view.lintReport ?? undefined,
    error: view.error ?? undefined,
  };
}
