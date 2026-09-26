/**
 * The files module's errors: a ModuleError (the router answers it with the
 * uniform `{ error, message, details?, hint }` shape) with the files-specific
 * codes and their HTTP statuses. `unsupported_type` is this module's own
 * code (declared in its `errors`); `quota_exceeded` is a core code (409),
 * shared with the data module.
 */
import { ModuleError } from '@drobek/modules';

export type FilesErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_type'
  | 'quota_exceeded';

const STATUS: Record<FilesErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_type: 415,
  quota_exceeded: 409,
};

export function filesErrorStatus(code: FilesErrorCode): number {
  return STATUS[code];
}

export class FilesError extends ModuleError {
  declare readonly code: FilesErrorCode;

  constructor(code: FilesErrorCode, message: string, opts: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(code, message, { status: STATUS[code], ...opts });
    this.name = 'FilesError';
  }
}
