/**
 * GET/POST /me/api-keys — server half (M2-04, NSO-284). The signed-in user's
 * personal `drk_` API keys: list (name, scopes, created, last used, revoked),
 * create (name + scopes; the raw key is in THIS action response only, never
 * stored or shown again) and revoke (immediate — the Resource Server reads the
 * key row on every request, no cache).
 *
 * Any signed-in user (keys are personal, not workspace-bound); anonymous →
 * /login. Mutations pass the global Origin check (apps/server) and are
 * audited into the user's personal workspace (../account.server.ts).
 */
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';
import { requireSessionUser } from '@drobek/auth';
import { listApiKeys, mcpResourceUri, SCOPES } from '@drobek/oauth';
import { checkApiKeyForm, shapeApiKeys } from '../account-view.js';
import {
  AccountError,
  createAccountApiKey,
  revokeAccountApiKey,
} from '../account.server.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A freshly created key must never be cached anywhere. */
export function headers() {
  return NO_STORE;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  const keys = await listApiKeys(user.id);
  return data(
    {
      keys: shapeApiKeys(keys),
      scopes: [...SCOPES] as string[],
      mcpUrl: mcpResourceUri(),
    },
    { headers: NO_STORE }
  );
}

export type ApiKeysActionData =
  | { ok: true; created: { id: string; name: string; scopes: string[]; key: string } }
  | { ok: false; error: string };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  try {
    if (intent === 'create') {
      const check = checkApiKeyForm(form.get('name'), form.getAll('scope'), SCOPES);
      if (!check.ok) {
        return data<ApiKeysActionData>({ ok: false, error: check.error }, { status: 400, headers: NO_STORE });
      }
      const created = await createAccountApiKey(user, { name: check.name, scopes: check.scopes });
      return data<ApiKeysActionData>({ ok: true, created }, { headers: NO_STORE });
    }
    if (intent === 'revoke') {
      await revokeAccountApiKey(user, String(form.get('id') ?? ''));
      return redirect('/me/api-keys', { headers: NO_STORE });
    }
    return data<ApiKeysActionData>({ ok: false, error: 'Unsupported action.' }, { status: 400, headers: NO_STORE });
  } catch (err) {
    if (err instanceof AccountError) {
      return data<ApiKeysActionData>({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
    }
    throw err;
  }
}
