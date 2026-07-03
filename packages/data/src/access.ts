/**
 * Per-collection access-mode enforcement (U10, PHY-56) — PURE decision, unit
 * tested without db/redis. The collection editor controls OPENNESS; drobek
 * always caps abuse (rate-limit + quota) regardless of the decision here.
 *
 * Modes:
 *   public-read  — anon reads; writes need an editor+ member.
 *   public-write — anon reads AND writes (schema still validated).
 *   locked       — no anon access; reads need a member (viewer+), writes an
 *                  editor+ member (or the authed MCP author / super-admin).
 *   owner-only   — RESERVED for U11 hosted-app end-user auth. U10 does NOT
 *                  implement per-end-user scoping, so record operations on an
 *                  owner-only collection are rejected as `not_implemented`
 *                  BEFORE this decision runs (see records.server.ts).
 */
import { roleAtLeast, type WorkspaceRole } from '@drobek/tenancy';

export const ACCESS_MODES = [
  'public-read',
  'public-write',
  'locked',
  'owner-only',
] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];

export function isAccessMode(value: unknown): value is AccessMode {
  return (
    typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
  );
}

export type DataOperation = 'read' | 'write';

/**
 * The resolved caller identity for an access decision. `authenticated` is true
 * only for a VERIFIED workspace member (dashboard session) or the authed MCP
 * author or a super-admin; `role` is their effective role in the app's
 * workspace. An anonymous REST request is `{ authenticated: false, role: null }`.
 */
export interface DataCaller {
  authenticated: boolean;
  role: WorkspaceRole | null;
}

export const ANON_CALLER: DataCaller = { authenticated: false, role: null };

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403 };

/** Minimum role for each operation on a non-public path. */
function minRoleFor(operation: DataOperation): WorkspaceRole {
  return operation === 'write' ? 'editor' : 'viewer';
}

/**
 * Decide whether `caller` may perform `operation` on a collection with
 * `accessMode`. owner-only is NOT handled here (rejected upstream).
 * - public-write: fully open (both ops).
 * - public-read + read: open.
 * - everything else: requires an authenticated member with a sufficient role;
 *   anon → 401 (authenticate), insufficient member → 403.
 */
export function decideDataAccess(input: {
  accessMode: AccessMode;
  operation: DataOperation;
  caller: DataCaller;
}): AccessDecision {
  const { accessMode, operation, caller } = input;

  if (accessMode === 'public-write') return { ok: true };
  if (accessMode === 'public-read' && operation === 'read') return { ok: true };

  // public-read writes, locked reads/writes → an authorized member is required.
  if (!caller.authenticated) return { ok: false, status: 401 };
  if (caller.role && roleAtLeast(caller.role, minRoleFor(operation))) {
    return { ok: true };
  }
  return { ok: false, status: 403 };
}

/**
 * The DASHBOARD (member-view) access decision — DISTINCT from decideDataAccess
 * above. The dashboard is the app owner's own view of its data, so a workspace
 * MEMBER may read EVERY collection of their app regardless of its access_mode
 * (public/anon gate does NOT apply): viewer+ reads, editor+ writes/deletes, a
 * non-member (null role) is denied. Tenant isolation (the app must belong to the
 * member's workspace) is enforced separately by resolveApp; this is purely the
 * membership + role gate.
 */
export function decideMemberDataAccess(input: {
  role: WorkspaceRole | null;
  operation: DataOperation;
}): boolean {
  if (!input.role) return false;
  return roleAtLeast(input.role, minRoleFor(input.operation));
}
