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
  'limit_exceeded',
  'secret_in_source',
  'app_locked',
  'app_locked_by_admin',
  'busy',
  'slug_taken',
  'not_publishable',
  // NSO-340: set_gallery_listing.
  'not_published',
  'user_confirmation_required',
  'gallery_hidden',
  'gallery_disabled',
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

export function notFound(what: 'app' | 'workspace' = 'app'): ToolError {
  return new ToolError('not_found', `${what} not found`);
}
