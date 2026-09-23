/**
 * POST /api/apps/:id/modules/:module/confirm|reject — the owner decides on a
 * pending platform-module change (M1-01). configure_module holds changes the
 * module marks as sensitive (confirmRequired) and hands the agent a
 * `confirm_url` (the dashboard page M2-02 renders at
 * /workspaces/<ws>/apps/<app>/modules/<module>); that page calls this API.
 *
 * Guards (app-api.server.ts, before anything changes): POST only; a dashboard
 * session (401); a REQUIRED dashboard Origin (403); the app's workspace role —
 * unknown app / not a member → the same 404, viewer → 403, editor,
 * workspace-admin and super-admin may decide — except a change the module
 * marks `confirmRole: 'admin'` (e.g. proxy upstream assignments, NSO-322 H3):
 * only a workspace admin / super-admin confirms it (editor → 403
 * `admin_required`; rejecting stays open to editors). Then the module must be
 * active; nothing pending → 409 `nothing_pending`. The change is applied (or
 * dropped) in one transaction with the audit row `module.confirm` /
 * `module.reject`, actor_kind `user`.
 */
import { data, type ActionFunctionArgs } from 'react-router';
import { isModuleError, moduleRuntime } from '@drobek/modules';
import { NO_STORE, apiError, authorizeAppApi } from '../app-api.server.js';
import { confirmRoleOf } from '../module-config.js';

const DECISIONS = new Set(['confirm', 'reject']);

export async function loader() {
  return apiError(405, 'method_not_allowed', 'POST to confirm or reject a pending module change.');
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== 'POST') {
    return apiError(405, 'method_not_allowed', 'POST to confirm or reject a pending module change.');
  }
  const decision = String(params.decision ?? '');
  if (!DECISIONS.has(decision)) return apiError(404, 'not_found', 'Not found');

  const auth = await authorizeAppApi(
    request,
    String(params.id ?? ''),
    'Confirming module changes needs the editor role in this workspace.',
    // M4-02: a taken-down app's module config cannot change (423 app_locked_by_admin).
    { refuseLocked: true }
  );
  if (!auth.ok) return auth.response;
  const { app, user, role } = auth;

  const runtime = await moduleRuntime();
  const input = {
    app: { id: app.id, slug: app.slug, workspaceId: app.workspaceId },
    module: String(params.module ?? ''),
    userId: user.id,
    role: confirmRoleOf(role),
  };
  try {
    const out = decision === 'confirm' ? await runtime.confirm(input) : await runtime.reject(input);
    return data({ ok: true, decision, ...out }, { headers: NO_STORE });
  } catch (err) {
    if (isModuleError(err)) {
      return apiError(err.status, err.code, err.message, err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {});
    }
    throw err;
  }
}
