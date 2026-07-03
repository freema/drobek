/**
 * Tenancy-wrapped /login/verify server module (U4, PHY-54): delegates to the
 * @drobek/auth action and, when it minted a session (302 + session cookie),
 * lazily ensures the user's personal workspace. Apps re-export THIS instead
 * of the auth module (component/meta still come from @drobek/auth). See
 * ensurePersonalWorkspaceAfterLogin for why this wrapping was chosen over a
 * hook registry inside the auth package.
 */
import type { ActionFunctionArgs } from 'react-router';
import { action as authAction } from '@drobek/auth/routes/login.verify.server';
import { ensurePersonalWorkspaceAfterLogin } from '../personal-workspace.server.js';

export { loader } from '@drobek/auth/routes/login.verify.server';

export async function action(args: ActionFunctionArgs) {
  const response = await authAction(args);
  await ensurePersonalWorkspaceAfterLogin(response);
  return response;
}
