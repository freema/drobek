/**
 * Typed insights-layer errors (PHY-123). Every rejection carries a stable
 * `code` so the beacon HTTP handler can map it to a status and the MCP tool
 * layer can surface `{ error, message }` — without string-matching.
 */
export type InsightsErrorCode =
  | 'invalid_request'
  | 'payload_too_large'
  | 'rate_limited'
  | 'not_found';

export class InsightsError extends Error {
  constructor(
    readonly code: InsightsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InsightsError';
  }
}

/** Map an InsightsError code to the HTTP status the beacon endpoint returns. */
export function insightsErrorStatus(code: InsightsErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'payload_too_large':
      return 413;
    case 'rate_limited':
      return 429;
    case 'not_found':
      return 404;
    default:
      return 500;
  }
}
