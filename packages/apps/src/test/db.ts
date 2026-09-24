/**
 * Test database: an in-process PGlite (real Postgres, WASM) with the core
 * migrations applied exactly as production applies them, installed as the
 * `@drobek/db` getDb() singleton.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@drobek/db/schema';
import { setDbForTests } from '@drobek/db';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/drizzle/migrations', import.meta.url)
);

const MIGRATION_TABLE = { migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' };

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** A copy of the migrations folder that stops after migration `lastIdx`. */
export function migrationsUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'drobek-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

export async function migrateTo(db: TestDb, folder = MIGRATIONS_DIR): Promise<void> {
  await migrate(db, { migrationsFolder: folder, ...MIGRATION_TABLE });
}

/** A fresh, fully migrated database installed as getDb(). */
export async function freshDb(): Promise<{ db: TestDb; pg: PGlite }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrateTo(db);
  setDbForTests(db);
  return { db, pg };
}
