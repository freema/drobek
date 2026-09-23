export type AppsErrorCode =
  | 'invalid_slug'
  | 'slug_taken'
  | 'invalid_path'
  | 'not_found'
  | 'not_publishable'
  | 'not_published'
  | 'invalid_settings'
  /** NSO-293: a super-admin took the app down (`apps.locked_reason`); nothing changes until a restore. */
  | 'app_locked_by_admin'
  /** NSO-293: an unknown takedown / report reason category. */
  | 'invalid_reason';

/** A caller-facing failure; `code` is stable (MCP tools return it verbatim). */
export class AppsError extends Error {
  readonly code: AppsErrorCode;
  /** For `slug_taken`: a free slug to offer instead (`<slug>-<4hex>`). */
  readonly suggestion?: string;
  /** For `app_locked_by_admin`: the takedown reason CATEGORY (never an internal note). */
  readonly reason?: string;

  constructor(code: AppsErrorCode, message: string, extra: { suggestion?: string; reason?: string } = {}) {
    super(message);
    this.name = 'AppsError';
    this.code = code;
    if (extra.suggestion) this.suggestion = extra.suggestion;
    if (extra.reason) this.reason = extra.reason;
  }
}
