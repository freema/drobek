/**
 * Typed proxy errors (PHY-59). Every rejection carries a stable `code` so the
 * route layer maps it to an HTTP status without string-matching. Messages are
 * ALWAYS secret-free (a decrypt/config failure must never echo key material).
 */
export type ProxyErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'path_not_allowed'
  | 'rate_limited'
  | 'ssrf_blocked'
  | 'upstream_error'
  | 'config_error';

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

/** Map a ProxyError code → the HTTP status the route returns. */
export function proxyErrorStatus(code: ProxyErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
    case 'ssrf_blocked':
    case 'path_not_allowed':
      return 403;
    case 'not_found':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      // A bad gateway to the upstream (DNS fail, timeout, connection refused).
      return 502;
    case 'config_error':
      // A misconfigured/missing KEK or an un-decryptable secret — fail CLOSED.
      return 500;
    default:
      return 500;
  }
}
