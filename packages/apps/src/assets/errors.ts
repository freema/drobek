/**
 * Asset failures (NSO-358): a stable `code` from the agent-dx error
 * catalogue, a sentence for the caller and the HTTP status the upload URL
 * answers with. The MCP tools map them to ToolErrors, the dashboard shows the
 * message, the upload URL answers `{ code, message, hint }`.
 */

export type AssetsErrorCode =
  | 'invalid_params'
  | 'asset_type_not_allowed'
  | 'asset_too_large'
  | 'asset_quota_exceeded'
  | 'asset_size_mismatch'
  | 'asset_not_found'
  | 'asset_path_taken'
  | 'upload_token_invalid'
  | 'rate_limited'
  | 'app_locked_by_admin'
  /** The app was deleted (or never existed) while the upload ran. */
  | 'not_found';

const STATUS: Record<AssetsErrorCode, number> = {
  not_found: 404,
  invalid_params: 400,
  asset_type_not_allowed: 415,
  asset_too_large: 413,
  asset_quota_exceeded: 413,
  asset_size_mismatch: 400,
  asset_not_found: 404,
  asset_path_taken: 409,
  upload_token_invalid: 404,
  rate_limited: 429,
  app_locked_by_admin: 423,
};

export class AssetsError extends Error {
  readonly code: AssetsErrorCode;
  readonly status: number;
  /** Machine-readable context (`limit`, `value`, `allowed`, …) — never a secret or a token. */
  readonly details: Record<string, unknown>;

  constructor(code: AssetsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AssetsError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isAssetsError(err: unknown): err is AssetsError {
  return err instanceof AssetsError;
}
