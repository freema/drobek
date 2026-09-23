/**
 * POST /api/apps/:id/end-user-sessions/revoke — the owner signs EVERY end user
 * of the app out at once (M1-02, PHY-76 #9): the app's session epoch goes up,
 * so every `drobek_eu` session issued before stops resolving on every host of
 * the app (preview, production, version hosts). Users sign in again with a
 * new code. The dashboard UI calls it (M2-03); the owner decides, never an
 * agent (no MCP tool).
 *
 * Guards (app-api.server.ts): POST only; a dashboard session (401); a
 * REQUIRED dashboard Origin (403); unknown app / not a member → 404; viewer →
 * 403. Audit `end_users.sessions_revoke`, actor_kind `user`.
 */
import { data, type ActionFunctionArgs } from 'react-router';
import { NO_STORE, apiError, authorizeAppApi } from '../app-api.server.js';
import { revokeAllEndUserSessions } from '../end-user-sessions.server.js';

export async function loader() {
  return apiError(405, 'method_not_allowed', 'POST to sign every user of this app out.');
}

export async function action({ request, params }: ActionFunctionArgs) {
  const auth = await authorizeAppApi(request, String(params.id ?? ''), 'Signing users out needs the editor role in this workspace.');
  if (!auth.ok) return auth.response;
  const { app, user } = auth;

  const epoch = await revokeAllEndUserSessions(app, user.id);
  return data({ ok: true, app_id: app.id, epoch }, { headers: NO_STORE });
}
