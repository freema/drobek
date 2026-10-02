export type AppsErrorCode =
  | 'invalid_slug'
  | 'slug_taken'
  | 'invalid_path'
  | 'not_found'
  | 'not_publishable'
  | 'not_published'
  | 'invalid_settings'
  /** A super-admin took the app down (`apps.locked_reason`); nothing changes until a restore. */
  | 'app_locked_by_admin'
  /** An unknown takedown / report reason category. */
  | 'invalid_reason'
  /**
   * The workspace holds APPS_MAX_PER_WORKSPACE live apps, or a new version would take its apps' versions past
   * WORKSPACE_SOURCE_QUOTA (`details.limit` / `details.value`, + `details.used_bytes` for the quota).
   */
  | 'limit_exceeded'
  /** The public gallery is off on this server (GALLERY_ENABLED). */
  | 'gallery_disabled'
  /** A super-admin hid the app's gallery entry; neither the owner nor an agent can list it. */
  | 'gallery_hidden'
  /** PUBLISH_APPROVAL=approval and a super-admin has not approved the workspace (`contact`). */
  | 'publish_not_approved'
  /** A super-admin turned publishing off for the workspace (`contact`), in every PUBLISH_APPROVAL mode. */
  | 'publish_blocked'
  /** The gallery app's owner does not allow duplicating it. */
  | 'not_duplicable'
  /**
   * The person made DUPLICATES_PER_USER_HOUR copies within the last hour, or a new version would pass
   * VERSIONS_PER_APP_HOUR / VERSIONS_PER_USER_HOUR (`details.limit` / `details.value` / `details.retry_after_seconds`).
   */
  | 'rate_limited'
  /** `createVersion` with `baseVersion` found a newer version than the one the write was based on. */
  | 'version_conflict';

export interface AppsErrorDetails {
  limit: string;
  value: number;
  retry_after_seconds?: number;
  used_bytes?: number;
}

/** A caller-facing failure; `code` is stable (MCP tools return it verbatim). */
export class AppsError extends Error {
  readonly code: AppsErrorCode;
  /** For `slug_taken`: a free slug to offer instead (`<slug>-<4hex>`). */
  readonly suggestion?: string;
  /** For `app_locked_by_admin`: the takedown reason CATEGORY (never an internal note). */
  readonly reason?: string;
  /**
   * For `limit_exceeded` / `rate_limited`: `{ limit: <ENV_NAME>, value }`, + `retry_after_seconds` for a version
   * over its rate, + `used_bytes` for a version over WORKSPACE_SOURCE_QUOTA.
   */
  readonly details?: AppsErrorDetails;
  /** For `publish_not_approved` / `publish_blocked`: the operator's e-mail (OPERATOR_EMAIL or a super-admin), when configured. */
  readonly contact?: string;

  constructor(
    code: AppsErrorCode,
    message: string,
    extra: { suggestion?: string; reason?: string; details?: AppsErrorDetails; contact?: string } = {}
  ) {
    super(message);
    this.name = 'AppsError';
    this.code = code;
    if (extra.suggestion) this.suggestion = extra.suggestion;
    if (extra.reason) this.reason = extra.reason;
    if (extra.details) this.details = extra.details;
    if (extra.contact) this.contact = extra.contact;
  }
}
