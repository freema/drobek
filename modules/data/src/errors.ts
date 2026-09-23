/**
 * The data module's errors: a ModuleError (the router answers it with the
 * uniform `{ error, message, details?, hint }` shape) with the data-specific
 * codes and their HTTP statuses.
 */
import { ModuleError } from '@drobek/modules';

export type DataErrorCode =
  | 'invalid_request'
  | 'invalid_schema'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'payload_too_large'
  | 'quota_exceeded';

const STATUS: Record<DataErrorCode, number> = {
  invalid_request: 400,
  invalid_schema: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  payload_too_large: 413,
  quota_exceeded: 409,
};

/** The HTTP status of a data error code. */
export function dataErrorStatus(code: DataErrorCode): number {
  return STATUS[code];
}

export class DataError extends ModuleError {
  declare readonly code: DataErrorCode;

  constructor(code: DataErrorCode, message: string, opts: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(code, message, { status: STATUS[code], ...opts });
    this.name = 'DataError';
  }
}
