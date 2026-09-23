/**
 * Visibility gate decision (U7, PHY-58; M0-06). Pure — evaluated BEFORE any
 * version or file lookup so a locked request never reaches app bytes.
 *
 * App hosts never read the dashboard session (they are other origins, and the
 * dashboard cookie is `__Host-` scoped to the dashboard host anyway), so the
 * only thing a visitor can present is the app-access cookie that the password
 * form sets. Owners and members unlock with the password too.
 */

export type Visibility = 'public' | 'password';

export interface VisibilityInput {
  visibility: Visibility;
  /** A valid, unexpired app-access cookie for THIS app is present. */
  hasAppAccess: boolean;
}

export type VisibilityDecision = { action: 'serve' } | { action: 'password' };

/** public → serve; password → serve with a valid app-access cookie, else the password page. */
export function decideVisibility(input: VisibilityInput): VisibilityDecision {
  if (input.visibility === 'public') return { action: 'serve' };
  return input.hasAppAccess ? { action: 'serve' } : { action: 'password' };
}
