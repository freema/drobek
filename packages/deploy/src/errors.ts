/**
 * Typed deploy-pipeline errors (U6, PHY-57). Every rejection the MCP tools can
 * surface to a client carries a stable `code` so the tool layer can map it to a
 * structured `{ error, message }` payload without string-matching.
 */
export type DeployErrorCode =
  | 'forbidden'
  | 'invalid_manifest'
  | 'index_html_required'
  | 'file_too_large'
  | 'app_too_large'
  | 'not_found'
  | 'missing_blobs'
  | 'invalid_state'
  | 'no_rollback_target';

export class DeployError extends Error {
  constructor(
    readonly code: DeployErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeployError';
  }
}
