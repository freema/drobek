/**
 * GET /workspaces/:slug/activity — server half of the workspace Activity view
 * (governance v1, PHY-85). Lists the append-only audit trail for THIS workspace,
 * newest-first, filterable by app (subject) + action, keyset-paginated.
 *
 * Authz: requireWorkspaceRole('workspace-admin') — the audit trail is
 * workspace-admin / super-admin ONLY. A viewer or editor → 403, a non-member →
 * 404, an anonymous request → /login redirect, all thrown by the middleware
 * BEFORE any read. (The pure rule is canReadActivity in ../view.ts.)
 *
 * The read is strictly workspace-scoped (listActivity filters by the authorized
 * workspaceId) and the subject is plain text with no join to `apps`, so events
 * for a DELETED / tombstoned app still list.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { AUDIT_ACTION_LIST, listActivity } from '@drobek/audit';
import { requireWorkspaceRole } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';
import { shapeActivity } from '../view.js';

const PAGE_SIZE = 50;

export interface ActivityQuery {
  /** Exact action filter (e.g. 'deploy.rollback'), or null. */
  action: string | null;
  /** App slug filter → matches the audit row's subject id (target), or null. */
  app: string | null;
  /** Opaque keyset cursor for the next (older) page, or null. */
  cursor: string | null;
}

export function parseActivityQuery(url: URL): ActivityQuery {
  const action = (url.searchParams.get('action') ?? '').trim() || null;
  const app = (url.searchParams.get('app') ?? '').trim() || null;
  const cursor = (url.searchParams.get('cursor') ?? '').trim() || null;
  return { action, app, cursor };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );

  const q = parseActivityQuery(new URL(request.url));

  const [result, apps] = await Promise.all([
    listActivity({
      workspaceId: access.workspace.id,
      action: q.action,
      subject: q.app,
      cursor: q.cursor,
      limit: PAGE_SIZE,
    }),
    listWorkspaceApps(access.workspace.id),
  ]);

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    items: shapeActivity(
      result.rows.map((r) => ({
        id: r.id,
        actorEmail: r.actorEmail,
        actorKind: r.actorKind,
        action: r.action,
        subjectType: r.subjectType,
        subject: r.target,
        createdAt: r.createdAt,
      }))
    ),
    nextCursor: result.nextCursor,
    filter: { action: q.action, app: q.app },
    actionOptions: [...AUDIT_ACTION_LIST],
    appOptions: apps
      .map((a) => a.slug)
      .sort((x, y) => x.localeCompare(y)),
  };
}
