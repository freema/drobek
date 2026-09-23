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
  'collections',
  'app_documents',
  'app_errors',
  'app_daily_stats',
];

/** The upload/deploy pipeline tables dropped by 0007_app_versions (NSO-281). */
const DROPPED_TABLES = ['deploys', 'deploy_files', 'blob_refs'];

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
  } finally {
    await client.end();
  }
});
