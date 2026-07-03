/**
 * Visibility gate decision (U7, PHY-58). Pure — evaluated BEFORE any
 * deploy_files / blob access so an unauthorized request never reaches app bytes.
 */

export type Visibility = 'public' | 'team' | 'password';

export interface VisibilityInput {
  visibility: Visibility;
  /** Session user is a member of the app's workspace. */
  isMember: boolean;
  /** Session user is a global super-admin (env override). */
  isSuperAdmin: boolean;
  /** A valid, unexpired app-access cookie is present (password apps). */
  hasAppAccess: boolean;
}

export type VisibilityDecision =
  | { action: 'serve' }
  /** Anti-enumeration 404 — a non-member must not learn the app exists. */
  | { action: 'not-found' }
  /** Show the password entry page. */
  | { action: 'password' };

/**
 * public   → always serve.
 * team     → serve iff a workspace member (super-admin override); otherwise
 *            404 (NOT 302/403). A non-member — anonymous OR signed-in — must not
 *            learn the app exists, mirroring `decideWorkspaceAccess` for the
 *            dashboard. The anti-enumeration 404 is the deliberate, documented
 *            choice over a /login redirect.
 * password → serve iff a valid app-access cookie is present, OR the requester
 *            is a workspace member / super-admin (owners never need the
 *            password); otherwise show the password page.
 */
export function decideVisibility(input: VisibilityInput): VisibilityDecision {
  switch (input.visibility) {
    case 'public':
      return { action: 'serve' };
    case 'team':
      return input.isSuperAdmin || input.isMember
        ? { action: 'serve' }
        : { action: 'not-found' };
    case 'password':
      return input.isSuperAdmin || input.isMember || input.hasAppAccess
        ? { action: 'serve' }
        : { action: 'password' };
  }
}
