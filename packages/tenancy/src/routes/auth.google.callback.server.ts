/**
 * Tenancy-wrapped /auth/google/callback server module (U4, PHY-54): delegates
 * to the @drobek/auth loader and, when it minted a session (302 + session
 * cookie), lazily ensures the user's personal workspace. Apps re-export THIS
 * instead of the auth module. Failure paths (no session cookie) pass through
 * untouched.
 */
import type { LoaderFunctionArgs } from 'react-router';
import { loader as authLoader } from '@drobek/auth/routes/auth.google.callback.server';
import { ensurePersonalWorkspaceAfterLogin } from '../personal-workspace.server.js';

export async function loader(args: LoaderFunctionArgs) {
  const response = await authLoader(args);
  await ensurePersonalWorkspaceAfterLogin(response);
  return response;
}
