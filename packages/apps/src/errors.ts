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
  | 'invalid_reason'
  /** NSO-329: the workspace holds APPS_MAX_PER_WORKSPACE live apps (`details.limit` / `details.value`). */
  | 'limit_exceeded'
  /** NSO-340: the public gallery is off on this server (GALLERY_ENABLED). */
  | 'gallery_disabled'
  /** NSO-340: a super-admin hid the app's gallery entry; neither the owner nor an agent can list it. */
  | 'gallery_hidden'
  /** NSO-366: PUBLISH_APPROVAL=approval and a super-admin has not approved the workspace (`contact`). */
  | 'publish_not_approved'
  /** NSO-366: a super-admin turned publishing off for the workspace (`contact`), in every PUBLISH_APPROVAL mode. */
  | 'publish_blocked'
  /** NSO-340: the gallery app's owner does not allow duplicating it. */
  | 'not_duplicable'
  /** NSO-340: the person made DUPLICATES_PER_USER_HOUR copies within the last hour (`details.limit` / `details.value`). */
  | 'rate_limited'
  /** NSO-382: `createVersion` with `baseVersion` found a newer version than the one the write was based on. */
  | 'version_conflict';

/** A caller-facing failure; `code` is stable (MCP tools return it verbatim). */
export class AppsError extends Error {
  readonly code: AppsErrorCode;
  /** For `slug_taken`: a free slug to offer instead (`<slug>-<4hex>`). */
  readonly suggestion?: string;
  /** For `app_locked_by_admin`: the takedown reason CATEGORY (never an internal note). */
  readonly reason?: string;
  /** For `limit_exceeded`: `{ limit: <ENV_NAME>, value }`. */
  readonly details?: { limit: string; value: number };
  /** For `publish_not_approved` / `publish_blocked`: the operator's e-mail (OPERATOR_EMAIL or a super-admin), when configured. */
  readonly contact?: string;

  constructor(
    code: AppsErrorCode,
    message: string,
    extra: { suggestion?: string; reason?: string; details?: { limit: string; value: number }; contact?: string } = {}
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
