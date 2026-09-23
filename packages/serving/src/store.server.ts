/**
 * The app hosts' read path + its caches (M0-06). Three in-process caches:
 *
 *  - host resolution  `slug → {target → {app, version}}` — what a host serves
 *    RIGHT NOW (the published pointer, the newest ok version, version N). This
 *    is the only mutable one: it is busted per slug by the `drobek:app-changed`
 *    events (every write, restore, publish; see subscribeServeCache) and has a
 *    short TTL backstop for changes no event announces (e.g. an SQL edit).
 *  - version manifests `versionId → served manifest` — a version is immutable,
 *    so this never needs busting (count-capped LRU).
 *  - file bytes `sha256 → Buffer` — content-addressed, byte-capped LRU
 *    (256 MiB by default).
 *
 *  - custom hosts (M3-01) `hostname → { slug | null } | null` — which app a
 *    custom domain serves (null = not a custom domain at all → the dashboard;
 *    `slug: null` = registered but unverified → 404). Same 60 s TTL; every
 *    `domain` app-changed event drops the whole map (bustCustomHosts).
 *
 * The password hash is never cached; the unlock POST reads it on demand.
 * The DB access sits behind `ServeLoaders`, so the unit tests run the real
 * caching logic against in-memory fakes.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppHostTarget } from '@drobek/apps';
import { appVersions, apps, blobs, getDb, versionFiles } from '@drobek/db';
import { primaryDomainOf, resolveCustomHost, type CustomHostResolution } from '@drobek/domains';
import { ByteLru, CountLru, DEFAULT_BLOB_CACHE_BYTES } from './lru.js';
import { servedManifest, type ServedManifest, type StoredFile } from './manifest.js';
import type { Visibility } from './visibility.js';

/** What the app hosts need to know about an app (no secrets). */
export interface ServeApp {
  id: string;
  slug: string;
  /** The owning workspace (module runtime: limits, audit). */
  workspaceId: string;
  visibility: Visibility;
  /** Raw `apps.frame_ancestors` (validated by the header builder). */
  frameAncestors: string | null;
  /**
   * M3-01: the app's verified PRIMARY custom domain — its production host
   * (`<slug>.<APPS_DOMAIN>`) answers 302 there. Resolved for prod/custom
   * targets only; absent/null = no redirect.
   */
  primaryDomain?: string | null;
  /** `apps.locked_reason` (NSO-293): non-null = taken down → every host answers 451. */
  lockedReason?: string | null;
}

export interface ServeVersion {
  id: string;
  number: number;
}

export interface Resolved {
  /** null → no live app with this slug. */
  app: ServeApp | null;
  /** null → the host has nothing to serve (not published / nothing compiled / no such ok version). */
  version: ServeVersion | null;
}

export interface ServeLoaders {
  /** The live app (not soft-deleted, status live) with this slug and the version its host serves. */
  resolve(target: AppHostTarget): Promise<Resolved>;
  loadFiles(versionId: string): Promise<StoredFile[]>;
  loadBlobs(sha256s: string[]): Promise<Map<string, Buffer>>;
  loadPasswordHash(appId: string): Promise<string | null>;
  /** M3-01: what a custom-domain candidate host is (absent → never a custom domain). */
  resolveCustomHost?(hostname: string): Promise<CustomHostResolution | null>;
}

export interface ServeStoreOptions {
  loaders?: ServeLoaders;
  /** Host-resolution TTL backstop (default 60 s). */
  resolveTtlMs?: number;
  blobCacheBytes?: number;
  now?: () => number;
}

export const RESOLVE_TTL_MS = 60_000;
const MAX_CACHED_SLUGS = 10_000;
const MAX_CACHED_MANIFESTS = 2_000;

function targetKey(t: AppHostTarget): string {
  // A custom domain serves exactly what the production host serves.
  return t.kind === 'version' ? `v${t.number}` : t.kind === 'custom' ? 'prod' : t.kind;
}

export class ServeStore {
  readonly loaders: ServeLoaders;
  readonly blobs: ByteLru;
  private readonly resolved = new CountLru<Map<string, { expires: number; value: Resolved }>>(MAX_CACHED_SLUGS);
  private readonly manifests = new CountLru<ServedManifest>(MAX_CACHED_MANIFESTS);
  private readonly customHosts = new CountLru<{ expires: number; value: CustomHostResolution | null }>(MAX_CACHED_SLUGS);
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ServeStoreOptions = {}) {
    this.loaders = opts.loaders ?? dbLoaders;
    this.blobs = new ByteLru(opts.blobCacheBytes ?? DEFAULT_BLOB_CACHE_BYTES);
    this.ttlMs = opts.resolveTtlMs ?? RESOLVE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async resolve(target: AppHostTarget): Promise<Resolved> {
    const key = targetKey(target);
    const bySlug = this.resolved.get(target.slug);
    const hit = bySlug?.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await this.loaders.resolve(target);
    const entry = this.resolved.get(target.slug) ?? new Map();
    entry.set(key, { expires: this.now() + this.ttlMs, value });
    this.resolved.set(target.slug, entry);
    return value;
  }

  /** M3-01: which app a custom-domain candidate serves (cached; see the module comment). */
  async resolveCustomHost(hostname: string): Promise<CustomHostResolution | null> {
    const hit = this.customHosts.get(hostname);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = this.loaders.resolveCustomHost ? await this.loaders.resolveCustomHost(hostname) : null;
    this.customHosts.set(hostname, { expires: this.now() + this.ttlMs, value });
    return value;
  }

  async manifest(versionId: string): Promise<ServedManifest> {
    const hit = this.manifests.get(versionId);
    if (hit) return hit;
    const m = servedManifest(await this.loaders.loadFiles(versionId));
    this.manifests.set(versionId, m);
    return m;
  }

  async blob(sha256: string): Promise<Buffer | null> {
    const hit = this.blobs.get(sha256);
    if (hit) return hit;
    const bytes = (await this.loaders.loadBlobs([sha256])).get(sha256) ?? null;
    if (bytes) this.blobs.set(sha256, bytes);
    return bytes;
  }

  passwordHash(appId: string): Promise<string | null> {
    return this.loaders.loadPasswordHash(appId);
  }

  /** Forget what every host of `slug` serves (a write, restore or publish happened). */
  bust(slug: string): void {
    this.resolved.delete(slug);
  }

  /** Forget every custom-host resolution (a domain was added, verified, unverified or removed). */
  bustCustomHosts(): void {
    this.customHosts.clear();
  }

  bustAll(): void {
    this.resolved.clear();
    this.customHosts.clear();
  }
}

// ── the production loaders (Postgres) ────────────────────────────────────────

async function resolveFromDb(target: AppHostTarget): Promise<Resolved> {
  const db = getDb();
  const [row] = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      workspaceId: apps.workspaceId,
      visibility: apps.visibility,
      frameAncestors: apps.frameAncestors,
      lockedReason: apps.lockedReason,
      status: apps.status,
      publishedVersionId: apps.publishedVersionId,
    })
    .from(apps)
    .where(and(eq(apps.slug, target.slug), isNull(apps.deletedAt)))
    .limit(1);
  if (!row || row.status !== 'live') return { app: null, version: null };
  const app: ServeApp = {
    id: row.id,
    slug: row.slug,
    workspaceId: row.workspaceId,
    visibility: row.visibility as Visibility,
    frameAncestors: row.frameAncestors,
    lockedReason: row.lockedReason,
  };

  const okVersion = (where: ReturnType<typeof and>) =>
    db
      .select({ id: appVersions.id, number: appVersions.number })
      .from(appVersions)
      .where(where)
      .orderBy(desc(appVersions.number))
      .limit(1);

  let version: ServeVersion | null = null;
  if (target.kind === 'prod' || target.kind === 'custom') {
    app.primaryDomain = await primaryDomainOf(app.id);
    if (row.publishedVersionId) {
      [version = null] = await okVersion(
        and(eq(appVersions.id, row.publishedVersionId), eq(appVersions.appId, app.id))
      );
    }
  } else if (target.kind === 'preview') {
    [version = null] = await okVersion(and(eq(appVersions.appId, app.id), eq(appVersions.compileStatus, 'ok')));
  } else {
    [version = null] = await okVersion(
      and(
        eq(appVersions.appId, app.id),
        eq(appVersions.number, target.number),
        eq(appVersions.compileStatus, 'ok')
      )
    );
  }
  return { app, version };
}

export const dbLoaders: ServeLoaders = {
  resolve: resolveFromDb,
  resolveCustomHost,
  async loadFiles(versionId) {
    const rows = await getDb()
      .select({
        path: versionFiles.path,
        sha256: versionFiles.sha256,
        size: versionFiles.size,
        kind: versionFiles.kind,
      })
      .from(versionFiles)
      .where(eq(versionFiles.versionId, versionId));
    return rows as StoredFile[];
  },
  async loadBlobs(sha256s) {
    if (sha256s.length === 0) return new Map();
    const rows = await getDb()
      .select({ sha256: blobs.sha256, bytes: blobs.bytes })
      .from(blobs)
      .where(inArray(blobs.sha256, sha256s));
    return new Map(rows.map((r) => [r.sha256, r.bytes]));
  },
  async loadPasswordHash(appId) {
    const [row] = await getDb()
      .select({ passwordHash: apps.passwordHash })
      .from(apps)
      .where(eq(apps.id, appId))
      .limit(1);
    return row?.passwordHash ?? null;
  },
};
