/**
 * Tool failures: `{ code, message, hint }` (+ optional details), `hint` taken
 * from the @drobek/agent-dx error catalogue. Every code a tool can emit is in
 * `TOOL_ERROR_CODES`; a unit test asserts each one has a catalogue entry.
 */
import { errorHint } from '@drobek/agent-dx';
import { lockCategory, lockedMessage } from '@drobek/apps';

export const TOOL_ERROR_CODES = [
  'not_found',
  'forbidden',
  'invalid_params',
  'invalid_path',
  // NSO-382: a write_files edit that does not apply to the latest version.
  'edit_mismatch',
  'limit_exceeded',
  'secret_in_source',
  'app_locked',
  'app_locked_by_admin',
  'busy',
  'slug_taken',
  'not_publishable',
  // NSO-366: publish in a workspace the operator has not allowed (PUBLISH_APPROVAL=approval) or blocked.
  'publish_not_approved',
  'publish_blocked',
  // NSO-340: set_gallery_listing.
  'not_published',
  'user_confirmation_required',
  'gallery_hidden',
  'gallery_disabled',
  // NSO-340: duplicate_app on a gallery app whose owner does not allow copies.
  'not_duplicable',
  'asset_too_large',
  'asset_type_not_allowed',
  'asset_quota_exceeded',
  'asset_path_taken',
  'asset_not_found',
  'rate_limited',
  // NSO-346: configure_module on an opt-in module that is off for the workspace.
  'module_not_enabled',
  // NSO-366: the custom-domain tools.
  'invalid_hostname',
  'hostname_not_allowed',
  'domain_already_added',
  'domain_taken',
  'domain_not_verified',
  'dns_unavailable',
  // NSO-372: register_upstream.
  'upstream_already_registered',
  'internal_error',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }

  /** The JSON body the agent sees. */
  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, hint: errorHint(this.code), ...this.details };
  }
}

/**
 * The ONE answer for "no such app/workspace" AND "not a member" — identical
 * bytes, so it is no enumeration oracle (NSO-282). The plan's `not_member`
 * code deliberately does not exist.
 */
/**
 * A super-admin took the app down (NSO-293): distinct from the single-writer
 * lease `app_locked`. The message names the reason CATEGORY only.
 */
export function lockedByAdmin(lockedReason: string | null | undefined): ToolError {
  const reason = lockCategory(lockedReason);
  return new ToolError('app_locked_by_admin', lockedMessage(reason), { reason });
}

/** NSO-366: the workspace may not publish (not approved yet, or blocked by the operator); `contact` = the operator's e-mail. */
export function publishRefused(
  code: 'publish_not_approved' | 'publish_blocked',
  message: string,
  contact: string | null | undefined
): ToolError {
  return new ToolError(code, message, contact ? { contact } : {});
}

export function notFound(what: 'app' | 'workspace' = 'app'): ToolError {
  return new ToolError('not_found', `${what} not found`);
}
