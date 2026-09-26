/**
 * `node dist/server/migrate.js` — apply every pending migration and exit
 * (M4-03, the upgrade step of docs/SELF-HOSTING.md):
 *
 *   docker compose … run --rm --no-deps drobek node dist/server/migrate.js
 *
 * The same work the server does on start — the core journal
 * (`drizzle.__drizzle_migrations_core`), then each module in DROBEK_MODULES
 * (`__drizzle_migrations_mod_<name>`) — without listening. Running it twice is
 * the upgrade's idempotency proof: drizzle records every applied migration in
 * its journal inside the migration transaction, so the second run finds
 * nothing to apply. The config checks of the server entry run first, so an
 * image that would refuse to start never touches the database.
 */
import { appsOriginConfigError } from '@drobek/apps';
import { trustProxyConfigError } from '@drobek/auth';
import { createConsoleLogger, secretsConfigError } from '@drobek/core';
import { dbErrorForLog, runCoreMigrations } from '@drobek/db';
import { domainsConfigError } from '@drobek/domains';
import { limitsProviderConfigError, loadModuleRuntime } from '@drobek/modules';
import { frameSrcConfigError, tlsAskConfigError } from '@drobek/serving';
import postgres from 'postgres';

const log = createConsoleLogger('migrate');

const configError =
  secretsConfigError(process.env) ??
  appsOriginConfigError(process.env) ??
  trustProxyConfigError(process.env) ??
  tlsAskConfigError(process.env) ??
  limitsProviderConfigError(process.env) ??
  domainsConfigError(process.env) ??
  frameSrcConfigError(process.env);
if (configError) {
  console.error(configError);
  process.exit(1);
}

/** Applied entries per journal table in the `drizzle` schema. */
async function journalCounts(): Promise<Record<string, number>> {
  const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const tables = await sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name LIKE '__drizzle_migrations_%'
      ORDER BY table_name`;
    const out: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql('drizzle')}.${sql(name)}`;
      out[name] = row?.n ?? 0;
    }
    return out;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const before = await journalCounts();
  await runCoreMigrations();
  // Loads DROBEK_MODULES exactly like the server and applies their migrations
  // (a module that cannot be loaded fails here, before the upgrade goes on).
  await loadModuleRuntime({ env: { ...process.env, DROBEK_MIGRATE_ON_START: '1' }, log: createConsoleLogger('modules') });
  const after = await journalCounts();
  const applied = Object.entries(after)
    .map(([table, n]) => ({ table, applied: n - (before[table] ?? 0), total: n }))
    .filter((j) => j.total > 0);
  const newly = applied.reduce((sum, j) => sum + j.applied, 0);
  log.info(newly === 0 ? 'migrations: nothing to apply (up to date)' : `migrations: applied ${newly}`, {
    journals: applied,
  });
  process.exit(0);
} catch (err) {
  console.error('migrate: failed —', dbErrorForLog(err));
  process.exit(1);
}
