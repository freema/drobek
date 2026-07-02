import { redirect, type ActionFunctionArgs } from 'react-router';
import { destroySession } from '~/lib/auth/session.server';

/** POST /auth/logout — delete the Redis session and clear the cookie. */
export async function action({ request }: ActionFunctionArgs) {
  const clearCookie = await destroySession(request);
  return redirect('/', { headers: { 'Set-Cookie': clearCookie } });
}

export async function loader() {
  throw redirect('/');
}

export default function AuthLogout() {
  return null;
}
