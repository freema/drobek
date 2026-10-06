/**
 * The app purge over a database with the core migrations AND every module
 * migration in the repository (modules/* and examples/*): an app deleted
 * APP_PURGE_AFTER_DAYS ago leaves no row behind that references it. The
 * columns that reference an app are read from the catalogue, so a table added
 * later is covered too — it needs a fixture row below and a foreign key the
 * purge can follow.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import { abuseReports, apps, auditLog, blobs, setDbForTests, users, workspaces } from '@drobek/db';
import {
  AssetDisk,
  DEFAULT_APP_PURGE_AFTER_DAYS,
  DEFAULT_APP_PURGE_INTERVAL_MS,
  appPurgeSettingsFromEnv,
  createApp,
  createVersion,
  deletionWindow,
  publish,
  purgeApp,
  purgeDeletedApps,
  releaseDeletedAppSlugs,
  softDeleteApp,
  sweepUnreferencedBlobs,
  type Actor,
} from './index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const SHA_A = 'a'.repeat(64);

/** The module migration folders of the repository: `[name, folder]`. */
function moduleMigrationFolders(): [string, string][] {
  const out: [string, string][] = [];
  for (const parent of ['modules', 'examples']) {
    for (const d of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const folder = join(ROOT, parent, d.name, 'migrations');
      if (d.isDirectory() && existsSync(join(folder, 'meta/_journal.json'))) out.push([d.name, folder]);
    }
  }
  return out;
}

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let wsId: string;
let userId: string;
let actor: Actor;
let disk: AssetDisk;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: join(ROOT, 'packages/db/drizzle/migrations'),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  for (const [name, folder] of moduleMigrationFolders()) {
    await migrate(db, { migrationsFolder: folder, migrationsTable: `__drizzle_migrations_mod_${name}`, migrationsSchema: 'drizzle' });
  }
  setDbForTests(db);
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'purger', name: 'Purger' }).returning();
  userId = u.id;
  wsId = w.id;
  actor = { userId, kind: 'user' };
  disk = new AssetDisk(mkdtempSync(join(tmpdir(), 'drobek-purge-assets-')));
});
afterAll(async () => pg.close());

let n = 0;
async function newApp(prefix = 'purge'): Promise<{ id: string; slug: string }> {
  n += 1;
  return createApp({ workspaceId: wsId, slug: `${prefix}-${n}`, actor });
}

async function deletedApp(daysAgo: number, prefix?: string): Promise<{ id: string; slug: string }> {
  const app = await newApp(prefix);
  await softDeleteApp(app.id, actor, { now: new Date(Date.now() - daysAgo * DAY) });
  return app;
}

async function exists(appId: string): Promise<boolean> {
  return (await db.select({ id: apps.id }).from(apps).where(eq(apps.id, appId))).length === 1;
}

interface AppColumn {
  table: string;
  column: string;
  /** `c` cascade, `n` set null, …; null = no foreign key to apps(id). */
  onDelete: string | null;
  isArray: boolean;
}

/** Every column of the public schema that holds an app id (by foreign key or by name). */
async function appColumns(): Promise<AppColumn[]> {
  const res = await pg.query<{ table: string; column: string; on_delete: string | null; is_array: boolean }>(`
    WITH fks AS (
      SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS on_delete
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public.apps'::regclass
    ), named AS (
      SELECT table_name::text AS tbl, column_name::text AS col, data_type = 'ARRAY' AS is_array
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name = 'app_id' OR column_name LIKE '%\\_app\\_id' OR column_name LIKE '%app\\_ids')
    )
    SELECT coalesce(f.tbl, n.tbl) AS table, coalesce(f.col, n.col) AS column, f.on_delete, coalesce(n.is_array, false) AS is_array
    FROM fks f FULL JOIN named n ON n.tbl = f.tbl AND n.col = f.col
    ORDER BY 1, 2`);
  return res.rows.map((r) => ({ table: r.table, column: r.column, onDelete: r.on_delete, isArray: r.is_array }));
}

async function referencing(c: AppColumn, appId: string): Promise<number> {
  const where = c.isArray ? `$1 = ANY ("${c.column}")` : `"${c.column}" = $1`;
  const res = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${c.table}" WHERE ${where}`, [appId]);
  return res.rows[0].n;
}

const ON_DELETE: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', d: 'SET DEFAULT' };

/** Arrays of app ids the purge edits itself (no foreign key can follow them). */
const PURGED_ARRAYS = ['upstreams.allowed_app_ids'];

/** One row per table that references an app — keyed by table; `id` is the app. */
const FIXTURES: Record<string, (id: string) => Promise<unknown>> = {
  app_versions: async (id) => {
    const v = await createVersion(id, [{ path: 'index.html', content: 'shared page' }, { path: 'only.js', content: `only ${id}` }], {
      actor,
      compile: { status: 'ok' },
    });
    await publish(id, v.id, actor);
    await pg.query(
      `INSERT INTO app_version_assets (version_id, app_id, name, content_type, size, sha256, storage_key) VALUES ($1, $2, 'film.mp4', 'video/mp4', 10, $3, $3)`,
      [v.id, id, SHA_A]
    );
  },
  app_version_assets: async () => {},
  app_assets: (id) =>
    pg.query(
      `INSERT INTO app_assets (app_id, name, content_type, size, sha256, storage_key) VALUES ($1, 'film.mp4', 'video/mp4', 10, $2, $2)`,
      [id, SHA_A]
    ),
  app_errors: (id) =>
    pg.query(`INSERT INTO app_errors (id, app_id, type, message, url, dedup_key) VALUES ($1, $2, 'error', 'boom', '/', 'k')`, [`err${id}`, id]),
  app_daily_stats: (id) => pg.query(`INSERT INTO app_daily_stats (app_id, day) VALUES ($1, '2026-09-01')`, [id]),
  app_traffic_daily: (id) => pg.query(`INSERT INTO app_traffic_daily (app_id, day, views) VALUES ($1, '2026-09-01', 3)`, [id]),
  app_traffic_top: (id) => pg.query(`INSERT INTO app_traffic_top (app_id, day, kind, key, views) VALUES ($1, '2026-09-01', 'path', '/', 3)`, [id]),
  app_version_loads: (id) => pg.query(`INSERT INTO app_version_loads (app_id, version_number, page_loads) VALUES ($1, 1, 4)`, [id]),
  app_compiles: (id) => pg.query(`INSERT INTO app_compiles (id, app_id, ok, trigger) VALUES ($1, $2, true, 'write_files')`, [`cmp${id}`, id]),
  module_request_stats: (id) =>
    pg.query(`INSERT INTO module_request_stats (app_id, module, status_class, day, count) VALUES ($1, 'data', '2xx', '2026-09-01', 3)`, [id]),
  module_configs: (id) => pg.query(`INSERT INTO module_configs (app_id, module, config) VALUES ($1, 'data', '{}')`, [id]),
  module_secrets: (id) =>
    pg.query(
      `INSERT INTO module_secrets (app_id, module, name, ciphertext, iv, auth_tag, wrapped_dek, kek_id) VALUES ($1, 'proxy', 'TOKEN', 'c', 'i', 't', 'w', 'k')`,
      [id]
    ),
  domains: (id) => pg.query(`INSERT INTO domains (id, app_id, hostname, verification_token) VALUES ($1, $2, $3, 'tok')`, [`dom${id}`, id, `${id}.example.com`]),
  abuse_reports: (id) => pg.query(`INSERT INTO abuse_reports (id, app_id, host, reason) VALUES ($1, $2, 'x.apps.example', 'spam')`, [`rep${id}`, id]),
  gallery_likes: (id) => pg.query(`INSERT INTO gallery_likes (app_id, user_id) VALUES ($1, $2)`, [id, userId]),
  gallery_opens: (id) => pg.query(`INSERT INTO gallery_opens (app_id, day, count) VALUES ($1, '2026-09-01', 2)`, [id]),
  apps: async (id) => {
    const copy = await newApp('copy');
    await pg.query(`UPDATE apps SET duplicated_from_app_id = $1, duplicated_from_slug = 'the-source' WHERE id = $2`, [id, copy.id]);
  },
  upstreams: (id) =>
    pg.query(
      `INSERT INTO upstreams (id, workspace_id, name, base_url, allowed_methods, allowed_path_prefixes, allowed_app_ids) VALUES ($1, $2, $1, 'https://api.example.com', '{GET}', '{/}', ARRAY[$3, 'other'])`,
      [`up${id}`, wsId, id]
    ),
  mod_auth_users: async (id) => {
    await pg.query(`INSERT INTO mod_auth_users (id, app_id, email) VALUES ($1, $2, 'ana@example.com')`, [`eu${id}`, id]);
    await pg.query(`INSERT INTO mod_auth_identities (id, app_id, user_id, provider, issuer, subject) VALUES ($1, $2, $3, 'oidc', 'https://idp.example', 'sub')`, [
      `ei${id}`,
      id,
      `eu${id}`,
    ]);
  },
  mod_auth_identities: async () => {},
  mod_data_documents: (id) =>
    pg.query(`INSERT INTO mod_data_documents (id, app_id, collection, doc, bytes) VALUES ($1, $2, 'todos', '{"t":"x"}', 9)`, [`doc${id}`, id]),
  mod_forms_submissions: (id) => pg.query(`INSERT INTO mod_forms_submissions (id, app_id, form, data) VALUES ($1, $2, 'contact', '{"m":"hi"}')`, [`sub${id}`, id]),
  mod_files: (id) => pg.query(`INSERT INTO mod_files (id, app_id, sha256, size, type) VALUES ($1, $2, $3, 5, 'image/png')`, [`file${id}`, id, SHA_A]),
  mod_sync_sources: async (id) => {
    await pg.query(`INSERT INTO mod_sync_sources (app_id, source) VALUES ($1, 'players')`, [id]);
    await pg.query(
      `INSERT INTO mod_sync_runs (id, app_id, source, trigger, started_at, duration_ms, status) VALUES ($1, $2, 'players', 'schedule', now(), 5, 'ok')`,
      [`run${id}`, id]
    );
  },
  mod_sync_runs: async () => {},
  mod_hello_waves: (id) => pg.query(`INSERT INTO mod_hello_waves (app_id, name) VALUES ($1, 'Ana')`, [id]),
  mod_acmecrm_contacts: (id) => pg.query(`INSERT INTO mod_acmecrm_contacts (app_id, email, source) VALUES ($1, 'ana@example.com', 'signin')`, [id]),
};

describe('settings', () => {
  it('APP_PURGE_AFTER_DAYS / APP_PURGE_INTERVAL_MS: positive integers, else the production defaults', () => {
    expect(appPurgeSettingsFromEnv({})).toEqual({ afterDays: DEFAULT_APP_PURGE_AFTER_DAYS, intervalMs: DEFAULT_APP_PURGE_INTERVAL_MS });
    expect(DEFAULT_APP_PURGE_AFTER_DAYS).toBe(30);
    expect(appPurgeSettingsFromEnv({ APP_PURGE_AFTER_DAYS: '7', APP_PURGE_INTERVAL_MS: '5000' })).toEqual({ afterDays: 7, intervalMs: 5000 });
    for (const bad of ['0', '-3', '1.5', 'soon', ' ']) {
      expect(appPurgeSettingsFromEnv({ APP_PURGE_AFTER_DAYS: bad, APP_PURGE_INTERVAL_MS: bad })).toEqual({ afterDays: 30, intervalMs: 3_600_000 });
    }
  });

  it('the address stays reserved 30 days, or until a sooner purge frees it', () => {
    expect(deletionWindow({})).toEqual({ slugReservedDays: 30, purgeDays: 30 });
    expect(deletionWindow({ APP_PURGE_AFTER_DAYS: '90' })).toEqual({ slugReservedDays: 30, purgeDays: 90 });
    expect(deletionWindow({ APP_PURGE_AFTER_DAYS: '7' })).toEqual({ slugReservedDays: 7, purgeDays: 7 });
  });
});

describe('every table that references an app', () => {
  it('references it with a foreign key the purge follows (ON DELETE CASCADE / SET NULL), or is an array the purge edits', async () => {
    const unhandled = (await appColumns())
      .filter((c) => !(c.onDelete === 'c' || c.onDelete === 'n') && !PURGED_ARRAYS.includes(`${c.table}.${c.column}`))
      .map((c) => `${c.table}.${c.column} (${c.onDelete === null ? 'no foreign key' : `ON DELETE ${ON_DELETE[c.onDelete] ?? c.onDelete}`})`);
    expect(unhandled, 'reference apps(id) ON DELETE CASCADE (or SET NULL)').toEqual([]);
  });

  it('has a fixture here, and after the purge none of its rows names the app', async () => {
    const columns = await appColumns();
    const tables = [...new Set(columns.map((c) => c.table))].sort();
    expect(tables, 'add a fixture row for each new table to FIXTURES').toEqual(Object.keys(FIXTURES).sort());
    expect(tables).toEqual(expect.arrayContaining(['app_versions', 'mod_data_documents', 'mod_forms_submissions', 'mod_auth_users', 'mod_files']));

    const app = await newApp();
    for (const seed of Object.values(FIXTURES)) await seed(app.id);
    for (const c of columns) expect(await referencing(c, app.id), `${c.table}.${c.column} before the purge`).toBeGreaterThan(0);
    await softDeleteApp(app.id, actor, { now: new Date(Date.now() - 31 * DAY) });

    const out = await purgeDeletedApps({ disk });
    expect(out.failed).toEqual([]);
    expect(out.purged).toContainEqual({ appId: app.id, workspaceId: wsId, slug: app.slug });
    expect(await exists(app.id)).toBe(false);
    for (const c of columns) expect(await referencing(c, app.id), `${c.table}.${c.column} after the purge`).toBe(0);

    // What only pointed at the app stays, without the pointer.
    const [report] = await db.select().from(abuseReports).where(eq(abuseReports.id, `rep${app.id}`));
    expect(report).toMatchObject({ appId: null, host: 'x.apps.example' });
    const copies = await pg.query<{ duplicated_from_slug: string }>(`SELECT duplicated_from_slug FROM apps WHERE duplicated_from_slug = 'the-source'`);
    expect(copies.rows).toHaveLength(1);
    const ups = await pg.query<{ allowed_app_ids: string[] }>(`SELECT allowed_app_ids FROM upstreams WHERE id = $1`, [`up${app.id}`]);
    expect(ups.rows[0].allowed_app_ids).toEqual(['other']);
  });
});

describe('purgeDeletedApps', () => {
  it('purges apps deleted APP_PURGE_AFTER_DAYS ago, never a live app or a newer delete', async () => {
    const old = await deletedApp(31);
    const recent = await deletedApp(29);
    const live = await newApp();
    const out = await purgeDeletedApps({ disk });
    expect(out.purged.map((p) => p.appId)).toContain(old.id);
    expect(await exists(old.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
    expect(await exists(live.id)).toBe(true);

    // afterDays moves the cutoff.
    const sooner = await purgeDeletedApps({ disk, afterDays: 7 });
    expect(sooner.purged.map((p) => p.appId)).toContain(recent.id);
    expect(await exists(live.id)).toBe(true);
  });

  it('keeps the audit trail and adds app.purge under the slug the app had (a released slug too)', async () => {
    const app = await deletedApp(40, 'audited');
    await releaseDeletedAppSlugs({ slug: app.slug });
    const out = await purgeDeletedApps({ disk });
    expect(out.purged).toContainEqual({ appId: app.id, workspaceId: wsId, slug: app.slug });
    const rows = await db
      .select({ action: auditLog.action, actorUserId: auditLog.actorUserId, meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, wsId), eq(auditLog.target, app.slug)))
      .orderBy(auditLog.createdAt);
    expect(rows.map((r) => r.action)).toEqual(['app.create', 'app.delete', 'app.slug_release', 'app.purge']);
    expect(rows.at(-1)).toMatchObject({ actorUserId: null, meta: { appId: app.id } });
  });

  it('frees the blobs only the purged app used for the blob GC; shared ones stay', async () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const shared = 'kept for the live app';
    const only = `only in ${n}`;
    const live = await newApp();
    await createVersion(live.id, [{ path: 'index.html', content: shared }], { actor, compile: { status: 'ok' } });
    const gone = await newApp();
    await createVersion(gone.id, [{ path: 'index.html', content: shared }, { path: 'x.js', content: only }], { actor, compile: { status: 'ok' } });
    await softDeleteApp(gone.id, actor, { now: new Date(Date.now() - 31 * DAY) });
    const blobExists = async (text: string) => (await db.select({ sha256: blobs.sha256 }).from(blobs).where(eq(blobs.sha256, sha(text)))).length === 1;
    expect(await blobExists(only)).toBe(true);
    await purgeDeletedApps({ disk });
    await sweepUnreferencedBlobs({ graceMs: 0 });
    expect(await blobExists(only)).toBe(false);
    expect(await blobExists(shared)).toBe(true);
  });

  it('removes the app’s asset directory', async () => {
    const app = await deletedApp(31);
    mkdirSync(join(disk.root, app.id), { recursive: true });
    writeFileSync(join(disk.root, app.id, SHA_A), 'bytes');
    await purgeDeletedApps({ disk });
    expect(existsSync(join(disk.root, app.id))).toBe(false);
  });

  it('reports an app a foreign key without ON DELETE holds, purges the others and retries it on the next run', async () => {
    await pg.exec(`CREATE TABLE mod_blocker_rows (app_id text NOT NULL REFERENCES apps(id))`);
    try {
      const held = await deletedApp(31);
      const free = await deletedApp(31);
      await pg.query(`INSERT INTO mod_blocker_rows (app_id) VALUES ($1)`, [held.id]);
      const out = await purgeDeletedApps({ disk });
      expect(out.purged.map((p) => p.appId)).toContain(free.id);
      expect(out.failed).toEqual([{ appId: held.id, error: expect.stringContaining('23503') }]);
      expect(await exists(held.id)).toBe(true);

      await pg.query(`DELETE FROM mod_blocker_rows`);
      const retry = await purgeDeletedApps({ disk });
      expect(retry.purged.map((p) => p.appId)).toEqual([held.id]);
      expect(await exists(held.id)).toBe(false);
    } finally {
      await pg.exec(`DROP TABLE mod_blocker_rows`);
    }
  });
});

describe('purgeApp', () => {
  it('purges only a deleted app (and only one deleted before deletedBefore)', async () => {
    const live = await newApp();
    expect(await purgeApp(live.id, { disk })).toBeNull();
    expect(await purgeApp('no-such-app', { disk })).toBeNull();
    const recent = await deletedApp(1);
    expect(await purgeApp(recent.id, { disk, deletedBefore: new Date(Date.now() - 2 * DAY) })).toBeNull();
    expect(await purgeApp(recent.id, { disk })).toEqual({ appId: recent.id, workspaceId: wsId, slug: recent.slug });
    expect(await exists(recent.id)).toBe(false);
    expect(await exists(live.id)).toBe(true);
  });
});
