/**
 * Read paths of the custom domains for the app hosts and Caddy (M3-01):
 * what a custom Host serves, whether Caddy may obtain a certificate for it,
 * and an app's primary domain (the 302 target of its default host).
 */
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { apps, domains, getDb } from '@drobek/db';

/**
 * What a custom host resolves to. `slug` = the live app a VERIFIED row of this
 * hostname belongs to; null = the name is registered but not (or no longer)
 * verified, or its app is gone — the apps side answers 404, never the dashboard.
 */
export interface CustomHostResolution {
  slug: string | null;
}

/** null → no app has this hostname at all (the host stays the dashboard's). */
export async function resolveCustomHost(hostname: string): Promise<CustomHostResolution | null> {
  const rows = await getDb()
    .select({ verifiedAt: domains.verifiedAt, slug: apps.slug, status: apps.status, deletedAt: apps.deletedAt })
    .from(domains)
    .innerJoin(apps, eq(apps.id, domains.appId))
    .where(eq(domains.hostname, hostname));
  if (rows.length === 0) return null;
  const live = rows.find((r) => r.verifiedAt !== null && r.deletedAt === null && r.status === 'live');
  return { slug: live?.slug ?? null };
}

/**
 * Caddy's `ask` for a name outside APPS_DOMAIN: true only for a VERIFIED
 * domain of a live app. A yes also records `cert_state = requested`
 * (best effort — the ask answer never waits on it failing).
 */
export async function customDomainAskAllowed(hostname: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: domains.id, certState: domains.certState })
    .from(domains)
    .innerJoin(apps, eq(apps.id, domains.appId))
    .where(
      and(eq(domains.hostname, hostname), isNotNull(domains.verifiedAt), isNull(apps.deletedAt), eq(apps.status, 'live'))
    )
    .limit(1);
  if (!row) return false;
  if (row.certState !== 'requested') {
    await getDb()
      .update(domains)
      .set({ certState: 'requested' })
      .where(and(eq(domains.id, row.id), ne(domains.certState, 'requested')))
      .catch(() => undefined);
  }
  return true;
}

/** The app's verified primary domain (its default host redirects there), or null. */
export async function primaryDomainOf(appId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ hostname: domains.hostname })
    .from(domains)
    .where(and(eq(domains.appId, appId), eq(domains.isPrimary, true), isNotNull(domains.verifiedAt)))
    .limit(1);
  return row?.hostname ?? null;
}

/** The app's verified custom domains (hostname order) — e.g. for the MCP `publish` result. */
export async function verifiedDomainsOf(appId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ hostname: domains.hostname })
    .from(domains)
    .where(and(eq(domains.appId, appId), isNotNull(domains.verifiedAt)))
    .orderBy(domains.hostname);
  return rows.map((r) => r.hostname);
}
