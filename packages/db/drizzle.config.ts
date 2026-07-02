import { defineConfig } from 'drizzle-kit';

/**
 * Core schema migrations (public AGPL repo).
 *
 * D4 (ratified): TWO drizzle journals against ONE `drobek` database —
 * core owns `__drizzle_migrations_core`, drobek-web (private repo) owns a
 * second migrations folder + `__drizzle_migrations_web` with a tablesFilter.
 * Never share a journal between the repos.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  migrations: {
    table: '__drizzle_migrations_core',
    schema: 'drizzle',
  },
});
