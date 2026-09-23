import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { TEST_ENV } from '../../playwright.config';

/**
 * Direct-SQL seeders for the @local specs. Apps + immutable versions are no
 * longer created over MCP (the upload/deploy pipeline is gone), so specs seed
 * the rows they need straight into the local compose Postgres — mirroring the
 * shapes @drobek/apps writes (apps → blobs → app_versions → version_files) but
 * WITHOUT importing it. Every helper opens + closes its own connection.
 *
 * LOCAL ONLY: every call refuses to run unless TEST_ENV=local. Specs must call
 * skipUnlessLocal() first. Not a spec file — Playwright never collects it.
 */

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://drobek:drobek@localhost:5441/drobek';

export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (TEST_ENV !== 'local') {
    throw new Error('tests-e2e seed helpers require TEST_ENV=local');
  }
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function newId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A unique, grammar-valid (^[a-z0-9]+(-[a-z0-9]+)*$, 3–40 chars) app slug. */
export function uniqueAppSlug(tag = 'app'): string {
  const base = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  // "e2e-" + base + "-" + suffix must stay ≤ 40 chars; never end base on "-".
  const room = 40 - 'e2e-'.length - 1 - suffix.length;
  const head = base.slice(0, room).replace(/-+$/, '') || 'app';
  return `e2e-${head}-${suffix}`;
}

export async function workspaceIdBySlug(slug: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT id FROM workspaces WHERE slug = $1`, [slug]);
    if (res.rows.length !== 1) throw new Error(`workspace ${slug} not found`);
    return res.rows[0].id as string;
  });
}

export async function userIdByEmail(email: string): Promise<string> {
  return withDb(async (c) => {
    const res = await c.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (res.rows.length !== 1) throw new Error(`user ${email} not found`);
    return res.rows[0].id as string;
  });
}

/** The user's personal workspace (created on first login). */
export async function personalWorkspaceOf(
  email: string
): Promise<{ id: string; slug: string }> {
  return withDb(async (c) => {
    const res = await c.query(
      `SELECT w.id, w.slug
         FROM workspaces w
         JOIN memberships m ON m.workspace_id = w.id
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1 AND w.kind = 'personal'`,
      [email]
    );
    if (res.rows.length !== 1) throw new Error(`no personal workspace for ${email}`);
    return { id: res.rows[0].id as string, slug: res.rows[0].slug as string };
  });
}

/**
 * Seed a membership (personal workspaces have no invite form; the role
 * middleware only reads the memberships table).
 */
export async function addMembership(
  userId: string,
  workspaceId: string,
  role: 'viewer' | 'editor' | 'workspace-admin'
): Promise<void> {
  await withDb((c) =>
    c.query(
      `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)`,
      [userId, workspaceId, role]
    )
  );
}

export interface SeededApp {
  id: string;
  slug: string;
}

/** Insert an app row (no versions yet → "not published"). */
export async function seedApp(opts: {
  workspaceId: string;
  slug?: string;
}): Promise<SeededApp> {
  const id = newId('app');
  const slug = opts.slug ?? uniqueAppSlug();
  await withDb((c) =>
    c.query(`INSERT INTO apps (id, workspace_id, slug) VALUES ($1, $2, $3)`, [
      id,
      opts.workspaceId,
      slug,
    ])
  );
  return { id, slug };
}

export interface SeedFile {
  path: string;
  content: string | Buffer;
  kind?: 'source' | 'built';
}

export interface SeededVersion {
  id: string;
  number: number;
}

/**
 * Insert one immutable version: upsert the file blobs (sha256 of the bytes),
 * then the app_versions row (number = max+1 unless given) and its
 * version_files — in one transaction, like @drobek/apps createVersion (minus
 * the audit row).
 */
export async function seedVersion(opts: {
  appId: string;
  number?: number;
  files?: SeedFile[];
  compileStatus?: 'pending' | 'ok' | 'error';
  compileErrors?: unknown;
  actorKind?: 'user' | 'agent';
  reasoning?: string | null;
  userId?: string | null;
}): Promise<SeededVersion> {
  const files = (
    opts.files ?? [{ path: 'index.html', content: '<!doctype html><h1>e2e</h1>' }]
  ).map((f) => {
    const bytes = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    return { path: f.path, kind: f.kind ?? 'source', bytes, sha256: sha256Hex(bytes) };
  });

  return withDb(async (c) => {
    await c.query('BEGIN');
    try {
      for (const f of files) {
        await c.query(
          `INSERT INTO blobs (sha256, bytes, size) VALUES ($1, $2, $3)
           ON CONFLICT (sha256) DO UPDATE SET created_at = now()`,
          [f.sha256, f.bytes, f.bytes.length]
        );
      }
      let number = opts.number;
      if (number === undefined) {
        const res = await c.query(
          `SELECT coalesce(max(number), 0)::int AS n FROM app_versions WHERE app_id = $1`,
          [opts.appId]
        );
        number = (res.rows[0].n as number) + 1;
      }
      const id = newId('ver');
      await c.query(
        `INSERT INTO app_versions
           (id, app_id, number, created_by_user_id, actor_kind, reasoning, compile_status, compile_errors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          opts.appId,
          number,
          opts.userId ?? null,
          opts.actorKind ?? 'agent',
          opts.reasoning ?? null,
          opts.compileStatus ?? 'ok',
          opts.compileErrors === undefined ? null : JSON.stringify(opts.compileErrors),
        ]
      );
      for (const f of files) {
        await c.query(
          `INSERT INTO version_files (version_id, path, sha256, size, kind)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, f.path, f.sha256, f.bytes.length, f.kind]
        );
      }
      await c.query('COMMIT');
      return { id, number };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

/** Point the app's published pointer at a version (no audit row — seeding only). */
export async function publishVersion(appId: string, versionId: string): Promise<void> {
  await withDb((c) =>
    c.query(`UPDATE apps SET published_version_id = $2 WHERE id = $1`, [appId, versionId])
  );
}

/** Mirrors @drobek/insights dedupKey: sha256(message NUL first-two-stack-lines)[0:32]. */
export function errorDedupKey(message: string, stack: string | null): string {
  const head = (stack ?? '').split('\n').slice(0, 2).join('\n').trim();
  return createHash('sha256').update(`${message}\0${head}`).digest('hex').slice(0, 32);
}

export interface SeedError {
  type?: 'error' | 'unhandledrejection';
  message: string;
  stack?: string | null;
  url: string;
  ua?: string | null;
}

/** Insert already-sanitized client error rows (what the beacon ingest stored). */
export async function seedAppErrors(appId: string, events: SeedError[]): Promise<void> {
  await withDb(async (c) => {
    for (const e of events) {
      const stack = e.stack ?? null;
      await c.query(
        `INSERT INTO app_errors (id, app_id, type, message, stack, url, ua, ts, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [
          newId('err'),
          appId,
          e.type ?? 'error',
          e.message,
          stack,
          e.url,
          e.ua ?? null,
          errorDedupKey(e.message, stack),
        ]
      );
    }
  });
}

/** Upsert today's (UTC) serving signals for an app. */
export async function seedDailyStats(
  appId: string,
  stats: { requestCount: number; count5xx?: number; path404Counts?: Record<string, number> }
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await withDb((c) =>
    c.query(
      `INSERT INTO app_daily_stats (app_id, day, path_404_counts, count_5xx, request_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, day) DO UPDATE
         SET path_404_counts = EXCLUDED.path_404_counts,
             count_5xx = EXCLUDED.count_5xx,
             request_count = EXCLUDED.request_count,
             updated_at = now()`,
      [appId, day, JSON.stringify(stats.path404Counts ?? {}), stats.count5xx ?? 0, stats.requestCount]
    )
  );
}

/**
 * Declare data-module collections for an app (merged into its `module_configs`
 * row for `data`, what configure_module('data') stores once applied).
 */
export async function seedDataCollections(
  appId: string,
  collections: Record<string, { schema?: Record<string, unknown>; rules?: Record<string, string> }>
): Promise<void> {
  await withDb((c) =>
    c.query(
      `INSERT INTO module_configs (app_id, module, config)
       VALUES ($1, 'data', jsonb_build_object('collections', $2::jsonb))
       ON CONFLICT (app_id, module) DO UPDATE
         SET config = module_configs.config || jsonb_build_object('collections',
               coalesce(module_configs.config -> 'collections', '{}'::jsonb) || $2::jsonb),
             updated_at = now()`,
      [appId, JSON.stringify(collections)]
    )
  );
}

/**
 * Insert records into a data-module collection, oldest first (each one a
 * millisecond later, so newest-first ordering is deterministic). Returns their
 * ids.
 */
export async function seedRecords(
  appId: string,
  collection: string,
  docs: Record<string, unknown>[],
  ownerId: string | null = null
): Promise<string[]> {
  return withDb(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < docs.length; i++) {
      const id = newId('rec');
      const json = JSON.stringify(docs[i]);
      await c.query(
        `INSERT INTO mod_data_documents (id, app_id, collection, owner_id, doc, bytes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() - make_interval(secs => $7::double precision),
                 now() - make_interval(secs => $7::double precision))`,
        [id, appId, collection, ownerId, json, Buffer.byteLength(json, 'utf8'), (docs.length - i) / 1000]
      );
      ids.push(id);
    }
    return ids;
  });
}
