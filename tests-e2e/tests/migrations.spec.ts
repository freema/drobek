import pg from 'pg';
import { expect, test } from '@playwright/test';
import { TEST_ENV } from '../playwright.config';

const CORE_TABLES = [
  'users',
  'workspaces',
  'memberships',
  'apps',
  'deploys',
  'blobs',
  'blob_refs',
  'deploy_files',
];

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
    const journal = await client.query(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations_core`
    );
    expect(journal.rows[0].n).toBeGreaterThanOrEqual(1);

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [CORE_TABLES]
    );
    const found = tables.rows.map((r: { table_name: string }) => r.table_name);
    expect(found.sort()).toEqual([...CORE_TABLES].sort());
  } finally {
    await client.end();
  }
});
