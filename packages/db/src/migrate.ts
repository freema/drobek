import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Apply the core Drizzle migrations at process start (the single drobek
 * container migrates itself — no separate tools image). Same folder and
 * journal as `drizzle.config.ts` (`drizzle.__drizzle_migrations_core`, D4).
 * Uses its own one-connection client so the app pool is never touched.
 */
export async function runCoreMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ and dist/ both sit one level below the package root.
  const migrationsFolder = resolve(here, '../drizzle/migrations');
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder,
      migrationsTable: '__drizzle_migrations_core',
      migrationsSchema: 'drizzle',
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
