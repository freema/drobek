/**
 * Test database: an in-process PGlite (real Postgres, WASM) with the core
 * migrations applied exactly as production applies them, installed as the
 * `@drobek/db` getDb() singleton. Mirrors packages/mcp/src/test/db.ts.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@drobek/db/schema';
import { setDbForTests } from '@drobek/db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/drizzle/migrations', import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function freshDb(): Promise<{ db: TestDb; pg: PGlite }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  return { db, pg };
}
