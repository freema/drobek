/**
 * GET /workspaces/:slug/activity — server half of the workspace Activity view
 * (governance v1, PHY-85). Lists the append-only audit trail for THIS workspace,
 * newest-first, filterable by app (subject) + action + actor kind (incl.
 * `end_user`, M2-04), keyset-paginated.
 *
 * Authz: requireWorkspaceRole('workspace-admin') — the audit trail is
 * workspace-admin / super-admin ONLY. A viewer or editor → 403, a non-member →
 * 404, an anonymous request → /login redirect, all thrown by the middleware
 * BEFORE any read.
 *
 * The read is strictly workspace-scoped (listActivity filters by the authorized
 * workspaceId) and the subject is plain text with no join to `apps`, so events
 * for a DELETED / tombstoned app still list.
 *
 * NSO-371: each row carries a readable summary, links to the objects it is
 * about that still exist (resolved per page against the live workspace — a
 * deleted app, version, upstream or domain is plain text with a note), and
 * its stored context for "Technical details" (credential-like keys redacted).
 * `?from=` / `?to=` (UTC days, inclusive) narrow the time range; the CSV
 * export reads the same query through `parseActivityQuery`.
 */
import { type LoaderFunctionArgs } from 'react-router';
import {
  AUDIT_ACTION_LIST,
  AUDIT_ACTOR_KINDS,
  listActivity,
  parseActorKind,
  type AuditActorKind,
} from '@drobek/audit';
import { moduleRuntime } from '@drobek/modules';
import { requireWorkspaceRole, workspaceNav } from '@drobek/tenancy';
import { loadActivityKnown } from '../activity-links.server.js';
import { activityDetails, activityRefs, activitySummary, dayRange, parseDay, resolveActivityRefs } from '../activity-view.js';
import { listWorkspaceApps } from '../apps.server.js';
import { shapeActivity } from '../view.js';

const PAGE_SIZE = 50;

export interface ActivityQuery {
  /** Exact action filter (e.g. 'app.restore'), or null. */
  action: string | null;
  /** App slug filter → matches the audit row's subject id (target), or null. */
  app: string | null;
  /** Actor-kind filter (`?actor=user|agent|end_user`), or null (M2-04). */
  actor: AuditActorKind | null;
  /** First UTC day of the range (`?from=YYYY-MM-DD`, inclusive), or null. */
  from: string | null;
  /** Last UTC day of the range (`?to=YYYY-MM-DD`, inclusive), or null. */
  to: string | null;
  /** The instants the range covers (`start` inclusive, `until` exclusive). */
  start: Date | null;
  until: Date | null;
  /** Opaque keyset cursor for the next (older) page, or null. */
  cursor: string | null;
}

export function parseActivityQuery(url: URL): ActivityQuery {
  const action = (url.searchParams.get('action') ?? '').trim() || null;
  const app = (url.searchParams.get('app') ?? '').trim() || null;
  const actor = parseActorKind(url.searchParams.get('actor'));
  const range = dayRange(parseDay(url.searchParams.get('from')), parseDay(url.searchParams.get('to')));
  const cursor = (url.searchParams.get('cursor') ?? '').trim() || null;
  return { action, app, actor, ...range, cursor };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const access = await requireWorkspaceRole(
    request,
    String(params.slug ?? ''),
    'workspace-admin'
  );

  const q = parseActivityQuery(new URL(request.url));

  const [result, apps, runtime] = await Promise.all([
    listActivity({
      workspaceId: access.workspace.id,
      action: q.action,
      subject: q.app,
      actorKind: q.actor,
      from: q.start,
      until: q.until,
      cursor: q.cursor,
      limit: PAGE_SIZE,
    }),
    listWorkspaceApps(access.workspace.id),
    moduleRuntime(),
  ]);

  const events = result.rows.map((r) => ({
    row: r,
    refs: activityRefs({ action: r.action, subjectType: r.subjectType, subject: r.target, meta: r.meta }),
  }));
  const known = await loadActivityKnown({
    workspaceId: access.workspace.id,
    workspaceSlug: access.workspace.slug,
    refs: events.flatMap((e) => e.refs),
    moduleNames: runtime.moduleFactsList().map((f) => f.name),
  });
  const extra = new Map(
    events.map(({ row: r, refs }) => [
      r.id,
      {
        summary: activitySummary({ action: r.action, subjectType: r.subjectType, subject: r.target, meta: r.meta }),
        links: resolveActivityRefs(refs, { createdAt: r.createdAt, viewerIsActor: r.actorUserId === access.user.id }, known),
        details: activityDetails(r.meta),
        at: r.createdAt.toISOString(),
      },
    ])
  );

  return {
    workspace: { slug: access.workspace.slug, name: access.workspace.name },
    /** NSO-342: the shared workspace chrome (breadcrumb, badges, tabs). */
    nav: await workspaceNav(access),
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
    ).map((it) => ({ ...it, ...extra.get(it.id)! })),
    nextCursor: result.nextCursor,
    filter: { action: q.action, app: q.app, actor: q.actor, from: q.from, to: q.to },
    actionOptions: [...AUDIT_ACTION_LIST],
    actorOptions: [...AUDIT_ACTOR_KINDS],
    appOptions: apps
      .map((a) => a.slug)
      .sort((x, y) => x.localeCompare(y)),
  };
}
