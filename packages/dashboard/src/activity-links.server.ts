/**
 * What still exists for one page of Activity rows (NSO-371): the few batched,
 * workspace-scoped reads `resolveActivityRefs` builds the links from — live
 * apps by slug, their versions and domains, the workspace's upstreams and
 * members, and the modules this server runs. Only ids referenced on the page
 * are read.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { appVersions, apps, domains, getDb, memberships, upstreams, users } from '@drobek/db';
import type { ActivityKnown, ActivityRef } from './activity-view.js';

export async function loadActivityKnown(input: {
  workspaceId: string;
  workspaceSlug: string;
  refs: ActivityRef[];
  moduleNames: Iterable<string>;
}): Promise<ActivityKnown> {
  const db = getDb();
  const slugs = new Set<string>();
  const upstreamIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of input.refs) {
    if (r.kind === 'app' || r.kind === 'version' || r.kind === 'domain' || r.kind === 'appModule') slugs.add(r.slug);
    else if (r.kind === 'upstream') upstreamIds.add(r.id);
    else if (r.kind === 'member') userIds.add(r.userId);
  }

  const [appRows, upstreamRows, memberRows] = await Promise.all([
    slugs.size
      ? db
          .select({ id: apps.id, slug: apps.slug, name: apps.name, createdAt: apps.createdAt })
          .from(apps)
          .where(and(eq(apps.workspaceId, input.workspaceId), isNull(apps.deletedAt), inArray(apps.slug, [...slugs])))
      : Promise.resolve([]),
    upstreamIds.size
      ? db
          .select({ id: upstreams.id })
          .from(upstreams)
          .where(and(eq(upstreams.workspaceId, input.workspaceId), inArray(upstreams.id, [...upstreamIds])))
      : Promise.resolve([]),
    userIds.size
      ? db
          .select({ id: users.id, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.workspaceId, input.workspaceId), inArray(memberships.userId, [...userIds])))
      : Promise.resolve([]),
  ]);

  const appIds = appRows.map((a) => a.id);
  const numbers = [...new Set(input.refs.flatMap((r) => (r.kind === 'version' ? [r.number] : [])))];
  const hostnames = [...new Set(input.refs.flatMap((r) => (r.kind === 'domain' ? [r.hostname] : [])))];
  const [versionRows, domainRows] = await Promise.all([
    appIds.length && numbers.length
      ? db
          .select({ appId: appVersions.appId, number: appVersions.number })
          .from(appVersions)
          .where(and(inArray(appVersions.appId, appIds), inArray(appVersions.number, numbers)))
      : Promise.resolve([]),
    appIds.length && hostnames.length
      ? db
          .select({ appId: domains.appId, hostname: domains.hostname })
          .from(domains)
          .where(and(inArray(domains.appId, appIds), inArray(domains.hostname, hostnames)))
      : Promise.resolve([]),
  ]);

  return {
    workspaceSlug: input.workspaceSlug,
    apps: new Map(appRows.map((a) => [a.slug, { id: a.id, name: a.name, createdAt: a.createdAt }])),
    versions: new Set(versionRows.map((v) => `${v.appId}:${v.number}`)),
    modules: new Set(input.moduleNames),
    upstreams: new Set(upstreamRows.map((u) => u.id)),
    members: new Map(memberRows.map((m) => [m.id, m.email])),
    domains: new Set(domainRows.map((d) => `${d.appId}:${d.hostname}`)),
  };
}
