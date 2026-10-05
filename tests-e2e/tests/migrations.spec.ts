import pg from 'pg';
import { expect, test } from '@playwright/test';
import { TEST_ENV } from '../playwright.config';

const CORE_TABLES = [
  'users',
  'workspaces',
  'memberships',
  'apps',
  'app_versions',
  'version_files',
  'blobs',
  'audit_log',
  'app_errors',
  'app_daily_stats',
  'app_compiles',
  'module_request_stats',
];

/**
 * The upload/deploy pipeline tables dropped by 0007_app_versions, and the
 * pre-module Data API tables the data module dropped (its migration 0000).
 */
const DROPPED_TABLES = ['deploys', 'deploy_files', 'blob_refs', 'collections', 'app_documents'];

// D4: core migrations live in the __drizzle_migrations_core journal
// (drobek-web's private journal __drizzle_migrations_web arrives in P0-C).
test('core drizzle journal applied and core tables exist @local', async () => {
  test.skip(TEST_ENV !== 'local', 'requires TEST_ENV=local (direct DB access)');

  const url =
    process.env.DATABASE_URL ??
    'postgresql://drobek:drobek@localhost:5441/drobek';
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // 0000 … 0007_app_versions → at least 8 journal entries.
    const journal = await client.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations_core`
    );
    expect(journal.rows[0].n).toBeGreaterThanOrEqual(8);

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [CORE_TABLES]
    );
    const found = tables.rows.map((r: { table_name: string }) => r.table_name);
    expect(found.sort()).toEqual([...CORE_TABLES].sort());

    // The removed deploy pipeline left nothing behind.
    const dropped = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [DROPPED_TABLES]
    );
    expect(dropped.rows).toEqual([]);

    // apps carries the published pointer, not the old deploy columns.
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'apps'`
    );
    const appCols = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(appCols).toContain('published_version_id');
    expect(appCols).not.toContain('active_deploy_id');
    expect(appCols).not.toContain('routing_mode');

    // A member can keep a version: who kept it and when.
    const versionCols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'app_versions'`
    );
    const vCols = versionCols.rows.map((r: { column_name: string }) => r.column_name);
    expect(vCols).toEqual(expect.arrayContaining(['kept_at', 'kept_by_user_id']));

    // The data module owns its records table (its own journal).
    const mod = await client.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations_mod_data`
    );
    expect(mod.rows[0].n).toBeGreaterThanOrEqual(1);
    const records = await client.query(`SELECT to_regclass('public.mod_data_documents')::text AS t`);
    expect(records.rows[0].t).toBe('mod_data_documents');
  } finally {
    await client.end();
  }
});

// Every start records, per journal, the image that brought its newest
// migration: an older image refuses the database and names that version.
test('the start recorded the image that knows each journal, and released the migration lock @local', async () => {
  test.skip(TEST_ENV !== 'local', 'requires TEST_ENV=local (direct DB access)');

  const url =
    process.env.DATABASE_URL ??
    'postgresql://drobek:drobek@localhost:5441/drobek';
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const recorded = await client.query(
      `SELECT r.migrations_table, r.image_version, r.module_version,
              r.newest_migration::text AS newest, (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations_core) AS core_newest
       FROM drizzle.__drobek_migration_images r
       WHERE r.migrations_table IN ('__drizzle_migrations_core', '__drizzle_migrations_mod_data')
       ORDER BY r.migrations_table`
    );
    expect(recorded.rows.map((r: { migrations_table: string }) => r.migrations_table)).toEqual([
      '__drizzle_migrations_core',
      '__drizzle_migrations_mod_data',
    ]);
    const [core, data] = recorded.rows as Array<{ image_version: string; module_version: string | null; newest: string; core_newest: string }>;
    expect(core.image_version).not.toBe('');
    expect(core.module_version).toBeNull();
    expect(core.newest).toBe(core.core_newest);
    expect(data.module_version).toMatch(/^\d+\.\d+\.\d+/);

    const locks = await client.query(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND objid = (hashtext('drobek:migrations')::bigint & 4294967295)::oid`
    );
    expect(locks.rows[0].n).toBe(0);
  } finally {
    await client.end();
  }
});
