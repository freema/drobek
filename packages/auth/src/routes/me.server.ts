/**
 * GET /me — server half of the route module (U2, PHY-53). Split from the
 * component file so the client bundle never touches server-only deps.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { requireSessionUser } from '../session.server.js';
import { isSuperAdmin } from '../super-admin.server.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  return {
    email: user.email,
    superAdmin: isSuperAdmin(user.email),
  };
}
