/** Expected, caller-safe failures of the custom-domain operations (M3-01). */
export type DomainsErrorCode =
  | 'invalid_hostname'
  | 'hostname_not_allowed'
  | 'limit_exceeded'
  | 'already_added'
  | 'domain_taken'
  | 'not_verified'
  | 'not_found';

export class DomainsError extends Error {
  constructor(
    readonly code: DomainsErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'DomainsError';
  }
}

/** HTTP status for a DomainsError code (dashboard actions). */
export function domainsErrorStatus(code: DomainsErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'already_added':
    case 'domain_taken':
      return 409;
    case 'limit_exceeded':
      return 403;
    default:
      return 400;
  }
}
