import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Start-up migrations, guarded twice around drizzle's migrator:
 *
 *  - one Postgres advisory lock (`hashtext('drobek:migrations')`, held by
 *    the session) serializes every journal of every process, so two
 *    replicas starting together apply each migration once — the second
 *    waits, then finds nothing to apply;
 *  - a journal that holds migrations this image does not know (a newer
 *    image migrated the database) stops the start with `SchemaAheadError`.
 *    drizzle alone would apply nothing and carry on against a schema the
 *    image does not know: it only compares the newest applied `created_at`
 *    with each migration's `when`.
 *
 * Each successful run records, per journal, the image that brought the
 * journal's newest migration (`drizzle.__drobek_migration_images`), so the
 * refusal can name the version to start.
 */

const SCHEMA = 'drizzle';
const IMAGES_TABLE = '__drobek_migration_images';
const LOCK_KEY = `hashtext('drobek:migrations')`;

/** The image that runs the migrations (`DROBEK_VERSION` + `GIT_SHA`, baked in by the release build). */
export interface DrobekImage {
  version: string;
  sha: string;
}

export function runningImage(env: NodeJS.ProcessEnv = process.env): DrobekImage {
  return { version: env.DROBEK_VERSION?.trim() || 'dev', sha: env.GIT_SHA?.trim() || 'dev' };
}

/** Structurally a `@drobek/core` Logger (which depends on this package). */
interface MigrationLog {
  info(message: string, meta?: Record<string, unknown>): void;
}

interface ModuleRef {
  name: string;
  version: string;
}

/**
 * One database session: plain queries and drizzle's migrator over the SAME
 * connection — the advisory lock belongs to the session that took it.
 */
export interface MigrationSession {
  query<T>(text: string, params?: (string | null)[]): Promise<T[]>;
  migrate(config: { migrationsFolder: string; migrationsTable: string; migrationsSchema: string }): Promise<void>;
}

export interface JournalMigrationOptions {
  migrationsFolder: string;
  /** The journal table in the `drizzle` schema. */
  migrationsTable: string;
  /** The module that owns the journal; absent for core. */
  module?: ModuleRef;
  /** Default: runningImage(). */
  image?: DrobekImage;
  log?: MigrationLog;
}

interface ImageRecord extends DrobekImage {
  moduleVersion: string | null;
}

function imageLabel(image: DrobekImage): string {
  return image.sha && image.sha !== 'dev' && image.sha !== image.version
    ? `drobek ${image.version} (${image.sha.slice(0, 12)})`
    : `drobek ${image.version}`;
}

function moduleLabel(module: { name: string; version: string | null }): string {
  return module.version ? `module ${module.name} ${module.version}` : `module ${module.name}`;
}

/**
 * The database holds migrations of this journal that the running image does
 * not know. The message names the image (and module) version to start.
 */
export class SchemaAheadError extends Error {
  constructor(opts: { migrationsTable: string; unknown: number; image: DrobekImage; module?: ModuleRef; migratedBy: ImageRecord | null }) {
    const { migrationsTable, unknown, image, module, migratedBy } = opts;
    const what = unknown === 1 ? '1 migration' : `${unknown} migrations`;
    const runs = module ? `${moduleLabel(module)} in ${imageLabel(image)}` : imageLabel(image);
    let need: string;
    if (!migratedBy) {
      need = 'A newer image migrated it: start the release the database was last upgraded to, or a newer one';
    } else if (module) {
      const newer = moduleLabel({ name: module.name, version: migratedBy.moduleVersion });
      need = `It was migrated by ${newer} in ${imageLabel(migratedBy)}: start ${imageLabel(migratedBy)} or newer with ${newer} or newer`;
    } else {
      need = `It was migrated by ${imageLabel(migratedBy)}: start ${imageLabel(migratedBy)} or newer`;
    }
    super(
      `the database schema is newer than this image — ${SCHEMA}.${migrationsTable} holds ${what} that ${runs} does not know. ` +
        `${need} (DROBEK_IMAGE_TAG). Migrations only go forward: an older image never runs on a newer schema.`
    );
    this.name = 'SchemaAheadError';
  }
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function lock(session: MigrationSession, opts: JournalMigrationOptions): Promise<void> {
  const [row] = await session.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`);
  if (row?.locked) return;
  opts.log?.info('waiting for another drobek process to finish its migrations', { journal: opts.migrationsTable });
  await session.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
}

async function unlock(session: MigrationSession): Promise<void> {
  try {
    await session.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
  } catch {
    // A broken connection already released the session's lock.
  }
}

/**
 * Apply one journal's pending migrations under the migration lock, after
 * refusing a journal that is ahead of this image. Returns how many were applied.
 */
export async function applyJournalMigrations(
  session: MigrationSession,
  opts: JournalMigrationOptions
): Promise<{ applied: number }> {
  const image = opts.image ?? runningImage();
  const migrations = readMigrationFiles({ migrationsFolder: opts.migrationsFolder });
  const newest = migrations.reduce((max, m) => Math.max(max, m.folderMillis), 0);
  const journal = `${ident(SCHEMA)}.${ident(opts.migrationsTable)}`;
  const images = `${ident(SCHEMA)}.${ident(IMAGES_TABLE)}`;

  await lock(session, opts);
  try {
    await session.query(`CREATE SCHEMA IF NOT EXISTS ${ident(SCHEMA)}`);
    await session.query(
      `CREATE TABLE IF NOT EXISTS ${images} (
        migrations_table text PRIMARY KEY,
        newest_migration bigint NOT NULL,
        image_version text NOT NULL,
        image_sha text NOT NULL,
        module_version text,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )`
    );

    let last = 0;
    const [present] = await session.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [journal]);
    if (present?.present) {
      const [state] = await session.query<{ last: string | null; unknown: number }>(
        `SELECT max(created_at)::text AS last, (count(*) FILTER (WHERE created_at > $1::bigint))::int AS unknown FROM ${journal}`,
        [String(newest)]
      );
      if (state && state.unknown > 0) {
        // Only a record that covers the newest applied migration names the right image.
        const [rec] = await session.query<{ version: string; sha: string; module_version: string | null }>(
          `SELECT image_version AS version, image_sha AS sha, module_version FROM ${images}
           WHERE migrations_table = $1 AND newest_migration >= $2::bigint`,
          [opts.migrationsTable, state.last]
        );
        throw new SchemaAheadError({
          migrationsTable: opts.migrationsTable,
          unknown: state.unknown,
          image,
          module: opts.module,
          migratedBy: rec ? { version: rec.version, sha: rec.sha, moduleVersion: rec.module_version } : null,
        });
      }
      last = state?.last ? Number(state.last) : 0;
    }

    await session.migrate({
      migrationsFolder: opts.migrationsFolder,
      migrationsTable: opts.migrationsTable,
      migrationsSchema: SCHEMA,
    });

    if (newest > 0) {
      await session.query(
        `INSERT INTO ${images} AS rec (migrations_table, newest_migration, image_version, image_sha, module_version)
         VALUES ($1, $2::bigint, $3, $4, $5)
         ON CONFLICT (migrations_table) DO UPDATE SET
           newest_migration = EXCLUDED.newest_migration,
           image_version = EXCLUDED.image_version,
           image_sha = EXCLUDED.image_sha,
           module_version = EXCLUDED.module_version,
           recorded_at = now()
         WHERE rec.newest_migration < EXCLUDED.newest_migration`,
        [opts.migrationsTable, String(newest), image.version, image.sha, opts.module?.version ?? null]
      );
    }
    return { applied: migrations.filter((m) => m.folderMillis > last).length };
  } finally {
    await unlock(session);
  }
}

/** A one-connection session on `databaseUrl`, so the app pool is never touched. */
async function withUrlSession<T>(databaseUrl: string | undefined, fn: (session: MigrationSession) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  // One connection that never recycles mid-run: the lock lives in its session.
  const sql = postgres(databaseUrl, { max: 1, max_lifetime: null, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(sql);
  try {
    return await fn({
      query: <R>(text: string, params: (string | null)[] = []) => sql.unsafe(text, params) as unknown as Promise<R[]>,
      migrate: (config) => migrate(db, config),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Apply the core Drizzle migrations at process start (the single drobek
 * container migrates itself — no separate tools image). Same folder and
 * journal as `drizzle.config.ts` (`drizzle.__drizzle_migrations_core`, D4).
 */
export async function runCoreMigrations(
  opts: { databaseUrl?: string; image?: DrobekImage; log?: MigrationLog } = {}
): Promise<{ applied: number }> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ and dist/ both sit one level below the package root.
  const migrationsFolder = resolve(here, '../drizzle/migrations');
  return withUrlSession(opts.databaseUrl ?? process.env.DATABASE_URL, (session) =>
    applyJournalMigrations(session, { ...opts, migrationsFolder, migrationsTable: '__drizzle_migrations_core' })
  );
}

/**
 * Apply ANOTHER drizzle migrations folder with its OWN journal table in the
 * `drizzle` schema (a platform module's tables, journal
 * `__drizzle_migrations_mod_<name>`), exactly like the core migrations.
 */
export async function runJournalMigrations(opts: JournalMigrationOptions & { databaseUrl?: string }): Promise<{ applied: number }> {
  return withUrlSession(opts.databaseUrl ?? process.env.DATABASE_URL, (session) => applyJournalMigrations(session, opts));
}
