/**
 * Typed data-layer errors (U10, PHY-55/PHY-56). Every rejection carries a
 * stable `code` so the MCP tool layer can surface `{ error, message }` and the
 * REST layer can map it to an HTTP status without string-matching.
 */
export type DataErrorCode =
  | 'invalid_request'
  | 'invalid_schema'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'doc_too_large'
  | 'app_too_large'
  | 'too_many_docs'
  | 'not_implemented';

export class DataError extends Error {
  /** Optional structured detail (e.g. ajv field errors) — never secrets. */
  readonly details?: unknown;
  constructor(
    readonly code: DataErrorCode,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'DataError';
    this.details = details;
  }
}

/** Map a DataError code to the HTTP status the REST layer returns. */
export function dataErrorStatus(code: DataErrorCode): number {
  switch (code) {
    case 'invalid_request':
    case 'invalid_schema':
      return 400;
    case 'validation_failed':
      return 422;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'doc_too_large':
    case 'app_too_large':
      return 413;
    case 'too_many_docs':
      return 409;
    case 'not_implemented':
      return 501;
    default:
      return 500;
  }
}
