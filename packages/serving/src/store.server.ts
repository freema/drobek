/**
 * The app hosts' read path + its caches. Three in-process caches:
 *
 *  - host resolution  `slug + host → {app, version}` — what a host serves
 *    RIGHT NOW (the published pointer, the newest ok version, version N). This
 *    is the only mutable one: it is busted per slug by the `drobek:app-changed`
 *    events (every write, restore, publish, settings and gallery change; see
 *    subscribeServeCache) and has a short TTL backstop for changes no event
 *    announces (e.g. an SQL edit). It holds at most 20 000 hosts over all apps
 *    (LRU) and drops expired entries (ExpiringLru); a version host is kept
 *    here only while its version exists.
 *  - version manifests `versionId → served manifest` — a version is immutable,
 *    so this never needs busting (count-capped LRU).
 *  - file bytes `sha256 → Buffer` — content-addressed, byte-capped LRU
 *    (256 MiB by default). The production hosts' split bundles (the
 *    code without its inline source map, and the map) share that budget,
 *    keyed by the sha256 and the file name; a bundle without an inline map
 *    is remembered in a count-capped set so it is scanned once.
 *
 *  - custom hosts `hostname → { slug | null } | null` — which app a
 *    custom domain serves (null = not a custom domain at all → the dashboard;
 *    `slug: null` = registered but unverified → 404). Same 60 s TTL; every
 *    `domain` app-changed event drops the whole map (bustCustomHosts).
 *
 *  - negative caches — a slug with no live app, a version host of a live app
 *    whose version does not exist (or did not compile), a hostname that is no
 *    custom domain at all. Wildcard DNS makes every label a new host, and
 *    `--v<N>` takes any N, so these are kept APART from the positive caches (a
 *    flood of random slugs or version numbers can never evict a real app's
 *    entry), count-capped (LRU) and short-lived (30 s). A slug miss answers
 *    every target of the slug (prod, preview, --vN) — the app row is what is
 *    missing. Busted like the positive entries: any app-changed event of the
 *    slug (incl. `create`, emitted by createApp, and every new version) forgets
 *    its misses, any `domain` event forgets every hostname miss.
 *
 * The password hash is never cached; the unlock POST reads it on demand.
 * The DB access sits behind `ServeLoaders`, so the unit tests run the real
 * caching logic against in-memory fakes.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { isGalleryVisible, type AppHostTarget } from '@drobek/apps';
import { CONFIG_FILE, feedbackWidgetEnabled } from '@drobek/compile';
import { appVersions, apps, blobs, getDb, versionFiles } from '@drobek/db';
import { primaryDomainOf, resolveCustomHost, type CustomHostResolution } from '@drobek/domains';
import { ByteLru, CountLru, DEFAULT_BLOB_CACHE_BYTES, ExpiringLru } from './lru.js';
import { servedManifest, type ServedManifest, type StoredFile } from './manifest.js';
import { splitInlineSourceMap, type SplitSourceMap } from './sourcemap.js';
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
   * The app's verified PRIMARY custom domain — its production host
   * (`<slug>.<APPS_DOMAIN>`) answers 302 there. Resolved for prod/custom
   * targets only; absent/null = no redirect.
   */
  primaryDomain?: string | null;
  /** `apps.locked_reason`: non-null = taken down → every host answers 451. */
  lockedReason?: string | null;
  /**
   * The public gallery shows the app right now (isGalleryVisible: listed,
   * published, public, not taken down, not deleted, not hidden) — its
   * production host and custom domains may be framed by the operator's
   * GALLERY_FRAME_ANCESTORS. Absent = false.
   */
  galleryVisible?: boolean;
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
  /** What a custom-domain candidate host is (absent → never a custom domain). */
  resolveCustomHost?(hostname: string): Promise<CustomHostResolution | null>;
}

export interface ServeStoreOptions {
  loaders?: ServeLoaders;
  /** Host-resolution TTL backstop (default 60 s). */
  resolveTtlMs?: number;
  /** How long a miss (unknown slug, missing version, unknown hostname) is remembered (default 30 s). */
  negativeTtlMs?: number;
  /** How many misses each negative cache keeps (default 10 000). */
  negativeMaxEntries?: number;
  /** How many app hosts the host-resolution cache keeps (default 20 000). */
  maxCachedHosts?: number;
  blobCacheBytes?: number;
  now?: () => number;
}

export const RESOLVE_TTL_MS = 60_000;
/** How long an unknown slug / version / hostname is remembered. */
export const NEGATIVE_TTL_MS = 30_000;
export const MAX_NEGATIVE_ENTRIES = 10_000;
const MAX_CACHED_HOSTS = 20_000;
const NO_APP: Resolved = Object.freeze({ app: null, version: null });
const MAX_CACHED_CUSTOM_HOSTS = 10_000;
const MAX_CACHED_MANIFESTS = 2_000;
/** The negative-cache host of a slug no live app owns (it answers every host of the slug). */
const ANY_HOST = '*';

function targetKey(t: AppHostTarget): string {
  // A custom domain serves exactly what the production host serves.
  return t.kind === 'version' ? `v${t.number}` : t.kind === 'custom' ? 'prod' : t.kind;
}

const hostKey = (slug: string, host: string) => `${slug}:${host}`;

export class ServeStore {
  readonly loaders: ServeLoaders;
  readonly blobs: ByteLru;
  private readonly resolved: ExpiringLru<Resolved>;
  private readonly manifests = new CountLru<ServedManifest>(MAX_CACHED_MANIFESTS);
  private readonly noInlineMap = new CountLru<true>(MAX_CACHED_MANIFESTS * 4);
  private readonly feedbackOn = new CountLru<boolean>(MAX_CACHED_MANIFESTS);
  private readonly customHosts: ExpiringLru<CustomHostResolution>;
  /** Slug misses (`<slug>:*`) and version misses (`<slug>:v<N>`, with the app). */
  private readonly missing: ExpiringLru<Resolved>;
  private readonly missingHosts: ExpiringLru<true>;

  constructor(opts: ServeStoreOptions = {}) {
    this.loaders = opts.loaders ?? dbLoaders;
    this.blobs = new ByteLru(opts.blobCacheBytes ?? DEFAULT_BLOB_CACHE_BYTES);
    const now = opts.now ?? Date.now;
    const ttlMs = opts.resolveTtlMs ?? RESOLVE_TTL_MS;
    const negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS;
    const negativeMax = opts.negativeMaxEntries ?? MAX_NEGATIVE_ENTRIES;
    this.resolved = new ExpiringLru(opts.maxCachedHosts ?? MAX_CACHED_HOSTS, ttlMs, now);
    this.customHosts = new ExpiringLru(MAX_CACHED_CUSTOM_HOSTS, ttlMs, now);
    this.missing = new ExpiringLru(negativeMax, negativeTtlMs, now);
    this.missingHosts = new ExpiringLru(negativeMax, negativeTtlMs, now);
  }

  async resolve(target: AppHostTarget): Promise<Resolved> {
    const { slug } = target;
    const key = hostKey(slug, targetKey(target));
    const hit =
      this.resolved.get(key) ??
      this.missing.get(hostKey(slug, ANY_HOST)) ??
      (target.kind === 'version' ? this.missing.get(key) : undefined);
    if (hit) return hit;
    const value = await this.loaders.resolve(target);
    if (!value.app) {
      this.resolved.deleteGroup(slug);
      this.missing.deleteGroup(slug);
      this.missing.set(hostKey(slug, ANY_HOST), NO_APP, slug);
      return NO_APP;
    }
    this.missing.delete(hostKey(slug, ANY_HOST));
    if (target.kind === 'version' && !value.version) this.missing.set(key, value, slug);
    else this.resolved.set(key, value, slug);
    return value;
  }

  /** Which app a custom-domain candidate serves (cached; see the module comment). */
  async resolveCustomHost(hostname: string): Promise<CustomHostResolution | null> {
    const hit = this.customHosts.get(hostname);
    if (hit) return hit;
    if (this.missingHosts.get(hostname)) return null;
    const value = this.loaders.resolveCustomHost ? await this.loaders.resolveCustomHost(hostname) : null;
    if (value === null) {
      this.customHosts.delete(hostname);
      this.missingHosts.set(hostname, true);
      return null;
    }
    this.missingHosts.delete(hostname);
    this.customHosts.set(hostname, value);
    return value;
  }

  /**
   * Does the cache already know this host as one a live app serves? No I/O —
   * the unknown-host limiter lets a throttled client through to such a host
   * without a lookup risk. The production, preview and custom hosts count once
   * any host of the slug is cached; a version host only when that very version
   * is (a throttled client never looks up version numbers one by one).
   */
  knowsLiveHost(target: AppHostTarget): boolean {
    if (target.kind === 'version') return this.resolved.get(hostKey(target.slug, targetKey(target))) !== undefined;
    return this.resolved.hasGroup(target.slug);
  }

  async manifest(versionId: string): Promise<ServedManifest> {
    const hit = this.manifests.get(versionId);
    if (hit) return hit;
    const m = servedManifest(await this.loaders.loadFiles(versionId));
    this.manifests.set(versionId, m);
    return m;
  }

  /**
   * Does version `versionId` show the feedback widget on its preview and
   * version hosts — false only when its drobek.json says `"feedback": false`.
   * A version is immutable, so the answer is cached like its manifest.
   */
  async feedbackEnabled(versionId: string): Promise<boolean> {
    const hit = this.feedbackOn.get(versionId);
    if (hit !== undefined) return hit;
    const config = (await this.loaders.loadFiles(versionId)).find((f) => f.kind === 'source' && f.path === CONFIG_FILE);
    const bytes = config ? await this.blob(config.sha256) : null;
    const on = feedbackWidgetEnabled(bytes ? bytes.toString('utf8') : undefined);
    this.feedbackOn.set(versionId, on);
    return on;
  }

  async blob(sha256: string): Promise<Buffer | null> {
    const hit = this.blobs.get(sha256);
    if (hit) return hit;
    const bytes = (await this.loaders.loadBlobs([sha256])).get(sha256) ?? null;
    if (bytes) this.blobs.set(sha256, bytes);
    return bytes;
  }

  /**
   * The bundle `sha256` served at `path` split into code + source
   * map (see sourcemap.ts). null = it carries no inline map (serve the blob
   * as is); undefined = the blob is missing.
   */
  async splitSourceMap(sha256: string, path: string): Promise<SplitSourceMap | null | undefined> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const codeKey = `${sha256}:code:${name}`;
    const mapKey = `${sha256}:map`;
    if (this.noInlineMap.get(codeKey)) return null;
    const code = this.blobs.get(codeKey);
    const map = this.blobs.get(mapKey);
    if (code && map) return { code, map };
    const bytes = await this.blob(sha256);
    if (!bytes) return undefined;
    const split = splitInlineSourceMap(bytes, path);
    if (!split) {
      this.noInlineMap.set(codeKey, true);
      return null;
    }
    this.blobs.set(codeKey, split.code);
    this.blobs.set(mapKey, split.map);
    return split;
  }

  passwordHash(appId: string): Promise<string | null> {
    return this.loaders.loadPasswordHash(appId);
  }

  /** Forget what every host of `slug` serves (a write, restore or publish happened). */
  bust(slug: string): void {
    this.resolved.deleteGroup(slug);
    this.missing.deleteGroup(slug);
  }

  /** Forget every custom-host resolution (a domain was added, verified, unverified or removed). */
  bustCustomHosts(): void {
    this.customHosts.clear();
    this.missingHosts.clear();
  }

  bustAll(): void {
    this.resolved.clear();
    this.customHosts.clear();
    this.missing.clear();
    this.missingHosts.clear();
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
      publishedAt: apps.publishedAt,
      deletedAt: apps.deletedAt,
      galleryListed: apps.galleryListed,
      galleryDescription: apps.galleryDescription,
      galleryHiddenAt: apps.galleryHiddenAt,
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
    galleryVisible: isGalleryVisible(row),
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
