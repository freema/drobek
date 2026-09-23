/**
 * GET/POST /me/connections — server half (M2-04, NSO-284). The OAuth clients
 * (DCR or CIMD) that currently hold a live grant for the signed-in user:
 * name from the registration / metadata document, how it registered, the
 * granted scopes and when it last got a token. "Revoke" deletes every access
 * + refresh token (and pending code) of that client for this user — its next
 * MCP call is 401 and its refresh token is `invalid_grant`.
 *
 * Any signed-in user; anonymous → /login. Audited into the personal
 * workspace (../account.server.ts).
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { requireSessionUser } from '@drobek/auth';
import { listConnections } from '@drobek/oauth';
import { shapeConnections } from '../account-view.js';
import { AccountError, revokeAccountConnection } from '../account.server.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  const connections = await listConnections(user.id);
  return { connections: shapeConnections(connections) };
}

export type ConnectionsActionData = { ok: false; error: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  try {
    if (intent === 'revoke') {
      await revokeAccountConnection(user, String(form.get('id') ?? ''));
      return redirect('/me/connections');
    }
    return data<ConnectionsActionData>({ ok: false, error: 'Unsupported action.' }, { status: 400 });
  } catch (err) {
    if (err instanceof AccountError) {
      return data<ConnectionsActionData>({ ok: false, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
