/**
 * POST /whats-new/dismiss — hides the "What's new" notice for the current
 * release line in this browser; a GET just goes home.
 */
import { redirect, type ActionFunctionArgs } from 'react-router';
import { dismissWhatsNew } from '../whats-new.server.js';

export function action({ request }: ActionFunctionArgs): Promise<Response> {
  return dismissWhatsNew(request);
}

export function loader(): Response {
  return redirect('/');
}
