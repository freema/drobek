/**
 * The super-admin's "All workspaces" list in one paginated query: the search
 * (`q`: name, slug or the e-mail of a workspace admin — the owner of a
 * personal workspace is its admin), the quick filters (kind, apps,
 * publishing), the sort and one page, each row with its aggregates — members,
 * live apps and the published ones, the first workspace admin and the last
 * activity (the newest version, publish or membership) — plus the number of
 * workspaces in all and of those that match.
 */
import { and, asc, desc, eq, exists, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { apps, appVersions, containsPattern, getDb, memberships, users, workspaces } from '@drobek/db';

export const ADMIN_WORKSPACE_SORTS = ['newest', 'oldest', 'name', 'apps', 'activity'] as const;
type AdminWorkspaceSort = (typeof ADMIN_WORKSPACE_SORTS)[number];

export const ADMIN_WORKSPACE_KINDS = ['personal', 'team'] as const;
export const ADMIN_WORKSPACE_APPS = ['none', 'some', 'published'] as const;
export const ADMIN_WORKSPACE_PUBLISHING = ['default', 'approved', 'blocked'] as const;

export interface AdminWorkspaceQuery {
  q?: string;
  kind?: (typeof ADMIN_WORKSPACE_KINDS)[number] | null;
  apps?: (typeof ADMIN_WORKSPACE_APPS)[number] | null;
  publishing?: (typeof ADMIN_WORKSPACE_PUBLISHING)[number] | null;
  sort?: AdminWorkspaceSort;
  /** 1-based. */
  page?: number;
  pageSize: number;
}

interface AdminWorkspaceRow {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  createdAt: Date;
  /** The owner of a personal workspace, the earliest workspace admin of a team one. */
  adminEmail: string | null;
  members: number;
  apps: number;
  publishedApps: number;
  /** The newest version, publish or membership in it; null = nothing yet. */
  lastActivityAt: Date | null;
  publishing: (typeof ADMIN_WORKSPACE_PUBLISHING)[number];
}

export interface AdminWorkspacePage {
  rows: AdminWorkspaceRow[];
  /** Every workspace of the server. */
  total: number;
  /** The workspaces the search and filters match (all pages). */
  matching: number;
}

export async function listAdminWorkspaces(query: AdminWorkspaceQuery): Promise<AdminWorkspacePage> {
  const db = getDb();
  const appAgg = db.$with('app_agg').as(
    db
      .select({
        workspaceId: apps.workspaceId,
        apps: sql<number>`(count(*) filter (where ${apps.deletedAt} is null))::int`.as('apps'),
        published: sql<number>`(count(*) filter (where ${apps.deletedAt} is null and ${apps.publishedVersionId} is not null))::int`.as(
          'published'
        ),
        lastPublish: sql<Date | null>`max(${apps.publishedAt})`.mapWith(apps.publishedAt).as('last_publish'),
      })
      .from(apps)
      .groupBy(apps.workspaceId)
  );
  const versionAgg = db.$with('version_agg').as(
    db
      .select({
        workspaceId: apps.workspaceId,
        lastVersion: sql<Date | null>`max(${appVersions.createdAt})`.mapWith(appVersions.createdAt).as('last_version'),
      })
      .from(appVersions)
      .innerJoin(apps, eq(apps.id, appVersions.appId))
      .groupBy(apps.workspaceId)
  );
  const memberAgg = db.$with('member_agg').as(
    db
      .select({
        workspaceId: memberships.workspaceId,
        members: sql<number>`count(*)::int`.as('members'),
        lastMember: sql<Date | null>`max(${memberships.createdAt})`.mapWith(memberships.createdAt).as('last_member'),
        adminEmail: sql<
          string | null
        >`(array_agg(${users.email} order by ${memberships.createdAt}, ${users.email}) filter (where ${memberships.role} = 'workspace-admin'))[1]`.as(
          'admin_email'
        ),
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .groupBy(memberships.workspaceId)
  );

  const appCount = sql<number>`coalesce(${appAgg.apps}, 0)`;
  const publishedCount = sql<number>`coalesce(${appAgg.published}, 0)`;
  const lastActivity = sql`greatest(${versionAgg.lastVersion}, ${appAgg.lastPublish}, ${memberAgg.lastMember})`;

  const conditions: (SQL | undefined)[] = [];
  const q = query.q?.trim();
  if (q) {
    const pattern = containsPattern(q);
    const admin = db
      .select({ one: sql`1` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, workspaces.id), eq(memberships.role, 'workspace-admin'), ilike(users.email, pattern)));
    conditions.push(or(ilike(workspaces.name, pattern), ilike(workspaces.slug, pattern), exists(admin)));
  }
  if (query.kind) conditions.push(eq(workspaces.kind, query.kind));
  if (query.apps === 'none') conditions.push(sql`${appCount} = 0`);
  if (query.apps === 'some') conditions.push(sql`${appCount} > 0`);
  if (query.apps === 'published') conditions.push(sql`${publishedCount} > 0`);
  if (query.publishing === 'blocked') conditions.push(isNotNull(workspaces.publishBlockedAt));
  if (query.publishing === 'approved') conditions.push(and(isNotNull(workspaces.publishApprovedAt), isNull(workspaces.publishBlockedAt)));
  if (query.publishing === 'default') conditions.push(and(isNull(workspaces.publishApprovedAt), isNull(workspaces.publishBlockedAt)));

  const sort = query.sort ?? 'newest';
  const order: SQL[] =
    sort === 'oldest'
      ? [asc(workspaces.createdAt), asc(workspaces.slug)]
      : sort === 'name'
        ? [sql`lower(${workspaces.name})`, asc(workspaces.slug)]
        : sort === 'apps'
          ? [sql`${appCount} desc`, sql`${publishedCount} desc`, asc(workspaces.slug)]
          : sort === 'activity'
            ? [sql`${lastActivity} desc nulls last`, asc(workspaces.slug)]
            : [desc(workspaces.createdAt), asc(workspaces.slug)];

  const pageSize = Math.max(1, query.pageSize);
  const page = Math.max(1, query.page ?? 1);
  const rows = await db
    .with(appAgg, versionAgg, memberAgg)
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      kind: workspaces.kind,
      createdAt: workspaces.createdAt,
      approvedAt: workspaces.publishApprovedAt,
      blockedAt: workspaces.publishBlockedAt,
      adminEmail: memberAgg.adminEmail,
      members: sql<number>`coalesce(${memberAgg.members}, 0)`.mapWith(Number),
      apps: appCount.mapWith(Number),
      publishedApps: publishedCount.mapWith(Number),
      lastActivityAt: sql<Date | null>`${lastActivity}`.mapWith(memberships.createdAt),
      matching: sql<number>`count(*) over ()`.mapWith(Number),
      total: sql<number>`(select count(*) from ${workspaces})`.mapWith(Number),
    })
    .from(workspaces)
    .leftJoin(appAgg, eq(appAgg.workspaceId, workspaces.id))
    .leftJoin(versionAgg, eq(versionAgg.workspaceId, workspaces.id))
    .leftJoin(memberAgg, eq(memberAgg.workspaceId, workspaces.id))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  if (rows.length === 0) {
    const [counts] = await db
      .with(appAgg)
      .select({
        matching: sql<number>`count(*)`.mapWith(Number),
        total: sql<number>`(select count(*) from ${workspaces})`.mapWith(Number),
      })
      .from(workspaces)
      .leftJoin(appAgg, eq(appAgg.workspaceId, workspaces.id))
      .where(and(...conditions));
    return { rows: [], total: counts?.total ?? 0, matching: counts?.matching ?? 0 };
  }
  return {
    total: rows[0]!.total,
    matching: rows[0]!.matching,
    rows: rows.map(({ approvedAt, blockedAt, matching: _m, total: _t, ...r }) => ({
      ...r,
      publishing: blockedAt ? 'blocked' : approvedAt ? 'approved' : 'default',
    })),
  };
}
