/**
 * GET/POST /me/delete — server half: the signed-in user deletes their own
 * account (only here: no MCP tool, like API keys and connections).
 *
 * GET: what the deletion does (@drobek/tenancy accountDeletionPlan) — the
 * workspaces deleted with the account, the ones the user leaves, and the team
 * workspaces that block it (the user is their only workspace-admin and other
 * members use them).
 *
 * POST `intent`: `send-code` e-mails a fresh code (its own OTP scope and send
 * limits) to the account's address; `delete` checks that code and deletes the
 * account (deleteAccount: the workspaces, memberships, API keys, OAuth tokens
 * and every session), then clears this browser's cookie → /login?deleted=account.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { destroySession, getClientIp, maskEmail, requireSessionUser } from '@drobek/auth';
import {
  DeletionError,
  accountDeletionPlan,
  checkAccountDeleteCode,
  deleteAccount,
  sendAccountDeleteCode,
} from '@drobek/tenancy';
import { appDeletionHooks } from '../deletion.server.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function headers() {
  return NO_STORE;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  const plan = await accountDeletionPlan(user.id);
  return data({ email: user.email, masked: maskEmail(user.email), plan }, { headers: NO_STORE });
}

export type DeleteAccountActionData =
  | { stage: 'code'; sent: boolean; error?: string }
  | { stage: 'start'; error: string };

const BAD_CODE = 'That code is not valid. Check the newest e-mail and try again, or ask for a new code.';

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const ip = getClientIp(request);
  const reply = (body: DeleteAccountActionData, status = 200) => data(body, { status, headers: NO_STORE });

  if (intent === 'send-code') {
    const plan = await accountDeletionPlan(user.id);
    if (plan.blockers.length > 0) {
      return reply({ stage: 'start', error: 'Your account cannot be deleted yet: a team workspace still needs you as its workspace-admin (see above).' }, 409);
    }
    const sent = await sendAccountDeleteCode({ email: user.email, ip });
    if (!sent.ok) return reply({ stage: 'start', error: sent.message }, sent.status);
    return reply({ stage: 'code', sent: sent.sent });
  }

  if (intent === 'delete') {
    const ok = await checkAccountDeleteCode({ email: user.email, code: String(form.get('code') ?? ''), ip });
    if (!ok) return reply({ stage: 'code', sent: false, error: BAD_CODE }, 400);
    try {
      await deleteAccount({ userId: user.id, hooks: await appDeletionHooks() });
    } catch (err) {
      if (err instanceof DeletionError) return reply({ stage: 'start', error: err.message }, 409);
      throw err;
    }
    const clear = await destroySession(request);
    return redirect('/login?deleted=account', { headers: { ...NO_STORE, 'Set-Cookie': clear } });
  }

  return reply({ stage: 'start', error: 'Unsupported action.' }, 400);
}
