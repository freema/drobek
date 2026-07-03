/**
 * Shared deploy types. `DeployState` mirrors the `deploy_state` pg enum in
 * @drobek/db/schema — keep the two in lock-step.
 */
export type DeployState =
  | 'awaiting_upload'
  | 'queued'
  | 'linting'
  | 'storing'
  | 'activating'
  | 'ready'
  | 'failed';

/** A terminal state no longer receives progress updates. */
export function isTerminalState(state: DeployState): boolean {
  return state === 'ready' || state === 'failed';
}
