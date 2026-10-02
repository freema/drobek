/**
 * The guarded start-up migrations on PGlite: a journal that is ahead of the
 * image refuses the start and names the version to run; every run holds the
 * migration lock, and a second process waits for it, then applies nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchemaAheadError, applyJournalMigrations, runningImage, type MigrationSession } from './migrate.js';

const CORE = fileURLToPath(new URL('../drizzle/migrations', import.meta.url));
const CORE_TABLE = '__drizzle_migrations_core';
const MOD_TABLE = '__drizzle_migrations_mod_guestbook';

const V1 = { version: 'v1.1.0', sha: 'aaaaaaa' };
const V2 = { version: 'v1.2.0', sha: 'bbbbbbb' };

const MIGRATIONS = [
  { tag: '0000_first', when: 1_790_000_000_000, sql: 'CREATE TABLE "first" (id text PRIMARY KEY);' },
  { tag: '0001_second', when: 1_790_000_100_000, sql: 'CREATE TABLE "second" (id text PRIMARY KEY);' },
  { tag: '0002_third', when: 1_790_000_200_000, sql: 'CREATE TABLE "third" (id text PRIMARY KEY);' },
];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder holding the first `n` of MIGRATIONS (an image that knows that many). */
function folder(n: number, migrations: typeof MIGRATIONS = MIGRATIONS): string {
  const dir = mkdtempSync(join(tmpdir(), 'drobek-migrate-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  const entries = migrations.slice(0, n).map((m, idx) => ({ idx, version: '7', when: m.when, tag: m.tag, breakpoints: true }));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
  for (const m of migrations.slice(0, n)) writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  return dir;
}

let pg: PGlite;
beforeEach(() => {
  pg = new PGlite();
});
afterEach(async () => {
  await pg.close();
});

function session(hooks: { query?: (text: string) => Promise<unknown[] | undefined>; beforeMigrate?: () => Promise<void> } = {}): MigrationSession {
  const db = drizzle(pg);
  return {
    query: async <T>(text: string, params: (string | null)[] = []) => {
      const hooked = await hooks.query?.(text);
      if (hooked) return hooked as T[];
      return (await pg.query<T>(text, params)).rows;
    },
    migrate: async (config) => {
      await hooks.beforeMigrate?.();
      await migrate(db, config);
    },
  };
}

async function one<T>(text: string): Promise<T> {
  return (await pg.query<T>(text)).rows[0];
}

const applied = (table: string) => one<{ n: number }>(`SELECT count(*)::int AS n FROM drizzle.${table}`).then((r) => r.n);
const advisoryLocks = () => one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`).then((r) => r.n);
const record = (table: string) =>
  pg
    .query<{ newest: string; image_version: string; image_sha: string; module_version: string | null }>(
      `SELECT newest_migration::text AS newest, image_version, image_sha, module_version
       FROM drizzle.__drobek_migration_images WHERE migrations_table = $1`,
      [table]
    )
    .then((r) => r.rows[0]);

describe('applyJournalMigrations', () => {
  it('applies a fresh journal, records the image that knows it and applies nothing the second time', async () => {
    const dir = folder(2);
    expect(await applyJournalMigrations(session(), { migrationsFolder: dir, migrationsTable: MOD_TABLE, image: V1 })).toEqual({ applied: 2 });
    expect(await applied(MOD_TABLE)).toBe(2);
    expect(await record(MOD_TABLE)).toEqual({ newest: String(MIGRATIONS[1].when), image_version: 'v1.1.0', image_sha: 'aaaaaaa', module_version: null });

    expect(await applyJournalMigrations(session(), { migrationsFolder: dir, migrationsTable: MOD_TABLE, image: V2 })).toEqual({ applied: 0 });
    expect(await applied(MOD_TABLE)).toBe(2);
    // The same migrations under a later image: the record keeps the first image that knew them.
    expect((await record(MOD_TABLE)).image_version).toBe('v1.1.0');
  });

  it('a newer image applies its migrations and takes over the record', async () => {
    await applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: MOD_TABLE, image: V1 });
    expect(await applyJournalMigrations(session(), { migrationsFolder: folder(3), migrationsTable: MOD_TABLE, image: V2 })).toEqual({ applied: 2 });
    expect(await record(MOD_TABLE)).toMatchObject({ newest: String(MIGRATIONS[2].when), image_version: 'v1.2.0' });
  });

  it('applies the core journal on an empty database', async () => {
    const res = await applyJournalMigrations(session(), { migrationsFolder: CORE, migrationsTable: CORE_TABLE, image: V1 });
    expect(res.applied).toBe(readMigrationFiles({ migrationsFolder: CORE }).length);
    expect(await applied(CORE_TABLE)).toBe(res.applied);
    expect(await one<{ t: string | null }>(`SELECT to_regclass('public.apps')::text AS t`)).toEqual({ t: 'apps' });
    expect((await record(CORE_TABLE)).image_version).toBe('v1.1.0');
  });
});

describe('an older image on a newer schema', () => {
  it('refuses the core journal and names the image that migrated it', async () => {
    await applyJournalMigrations(session(), { migrationsFolder: folder(3), migrationsTable: CORE_TABLE, image: V2 });

    const refused = applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: CORE_TABLE, image: V1 });
    await expect(refused).rejects.toBeInstanceOf(SchemaAheadError);
    await expect(refused).rejects.toThrow(
      'the database schema is newer than this image — drizzle.__drizzle_migrations_core holds 2 migrations that drobek v1.1.0 (aaaaaaa) does not know. ' +
        'It was migrated by drobek v1.2.0 (bbbbbbb): start drobek v1.2.0 (bbbbbbb) or newer (DROBEK_IMAGE_TAG).'
    );
    // Nothing changed, and the lock is free again.
    expect(await applied(CORE_TABLE)).toBe(3);
    expect((await record(CORE_TABLE)).image_version).toBe('v1.2.0');
    expect(await advisoryLocks()).toBe(0);
  });

  it('refuses a module journal and names the module and image versions', async () => {
    const guestbook = (version: string) => ({ name: 'guestbook', version });
    await applyJournalMigrations(session(), { migrationsFolder: folder(2), migrationsTable: MOD_TABLE, module: guestbook('1.1.0'), image: V2 });
    expect((await record(MOD_TABLE)).module_version).toBe('1.1.0');

    await expect(
      applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: MOD_TABLE, module: guestbook('1.0.0'), image: V1 })
    ).rejects.toThrow(
      'drizzle.__drizzle_migrations_mod_guestbook holds 1 migration that module guestbook 1.0.0 in drobek v1.1.0 (aaaaaaa) does not know. ' +
        'It was migrated by module guestbook 1.1.0 in drobek v1.2.0 (bbbbbbb): start drobek v1.2.0 (bbbbbbb) or newer with module guestbook 1.1.0 or newer'
    );
  });

  it('without a record (migrated before images were recorded) asks for the release it was last upgraded to', async () => {
    await migrate(drizzle(pg), { migrationsFolder: folder(2), migrationsTable: CORE_TABLE, migrationsSchema: 'drizzle' });

    await expect(applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: CORE_TABLE, image: V1 })).rejects.toThrow(
      'holds 1 migration that drobek v1.1.0 (aaaaaaa) does not know. A newer image migrated it: start the release the database was last upgraded to, or a newer one'
    );
  });

  it('does not name an image whose record predates the newest applied migration', async () => {
    await applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: CORE_TABLE, image: V1 });
    // Migrated further outside the guard (drizzle-kit migrate): the record still names V1.
    await migrate(drizzle(pg), { migrationsFolder: folder(3), migrationsTable: CORE_TABLE, migrationsSchema: 'drizzle' });

    const refused = applyJournalMigrations(session(), { migrationsFolder: folder(2), migrationsTable: CORE_TABLE, image: V2 });
    await expect(refused).rejects.toThrow('holds 1 migration that drobek v1.2.0 (bbbbbbb) does not know. A newer image migrated it');
    await expect(refused).rejects.not.toThrow('v1.1.0');
  });

  it('names a development image without a version by its commit', async () => {
    await applyJournalMigrations(session(), { migrationsFolder: folder(2), migrationsTable: CORE_TABLE, image: runningImage({ GIT_SHA: 'ccccccc' }) });
    await expect(
      applyJournalMigrations(session(), { migrationsFolder: folder(1), migrationsTable: CORE_TABLE, image: runningImage({}) })
    ).rejects.toThrow('that drobek dev does not know. It was migrated by drobek dev (ccccccc): start drobek dev (ccccccc) or newer');
  });
});

describe('the migration lock', () => {
  it('is held while drizzle migrates and released afterwards', async () => {
    let during = -1;
    await applyJournalMigrations(
      session({
        beforeMigrate: async () => {
          during = await advisoryLocks();
        },
      }),
      { migrationsFolder: folder(1), migrationsTable: MOD_TABLE, image: V1 }
    );
    expect(during).toBe(1);
    expect(await advisoryLocks()).toBe(0);
  });

  it('is released when a migration fails, and the journal stays as it was', async () => {
    const broken = folder(2, [MIGRATIONS[0], { ...MIGRATIONS[1], sql: 'CREATE TABLE "first" (id text PRIMARY KEY);' }]);
    await expect(applyJournalMigrations(session(), { migrationsFolder: broken, migrationsTable: MOD_TABLE, image: V1 })).rejects.toThrow();
    expect(await advisoryLocks()).toBe(0);
    expect(await one<{ t: string | null }>(`SELECT to_regclass('drizzle.${MOD_TABLE}')::text AS t`)).toEqual({ t: `drizzle.${MOD_TABLE}` });
    expect(await applied(MOD_TABLE)).toBe(0);
  });

  it('makes a second process wait until the first finished, then it applies nothing', async () => {
    // PGlite is one session, so the other process's hold on the lock is
    // simulated: B's try-lock fails while A holds it, and B's blocking lock
    // returns once A unlocked. Everything else is real SQL on one database.
    const dir = folder(3);
    let aHolds = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let aMigrating!: () => void;
    const migrating = new Promise<void>((r) => (aMigrating = r));
    let aUnlocked!: () => void;
    const unlocked = new Promise<void>((r) => (aUnlocked = r));

    const a = session({
      query: async (text) => {
        if (text.includes('pg_try_advisory_lock')) aHolds = true;
        if (text.includes('pg_advisory_unlock')) {
          aHolds = false;
          aUnlocked();
        }
        return undefined;
      },
      beforeMigrate: async () => {
        aMigrating();
        await gate;
      },
    });
    let bMigrated = false;
    const b = session({
      query: async (text) => {
        if (text.includes('pg_try_advisory_lock') && aHolds) return [{ locked: false }];
        if (text.includes('pg_advisory_lock(') && aHolds) await unlocked;
        return undefined;
      },
      beforeMigrate: async () => {
        bMigrated = true;
      },
    });
    const waited: Array<Record<string, unknown> | undefined> = [];

    const first = applyJournalMigrations(a, { migrationsFolder: dir, migrationsTable: MOD_TABLE, image: V2 });
    await migrating;
    const second = applyJournalMigrations(b, {
      migrationsFolder: dir,
      migrationsTable: MOD_TABLE,
      image: V2,
      log: { info: (message, meta) => waited.push({ message, ...meta }) },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(waited).toEqual([{ message: 'waiting for another drobek process to finish its migrations', journal: MOD_TABLE }]);
    expect(bMigrated).toBe(false);

    releaseGate();
    expect(await first).toEqual({ applied: 3 });
    expect(await second).toEqual({ applied: 0 });
    expect(bMigrated).toBe(true);
    expect(await applied(MOD_TABLE)).toBe(3);
    expect(await advisoryLocks()).toBe(0);
  });
});

describe('runningImage', () => {
  it('reads DROBEK_VERSION and GIT_SHA, else dev', () => {
    expect(runningImage({ DROBEK_VERSION: ' v0.7.5 ', GIT_SHA: 'abc1234' })).toEqual({ version: 'v0.7.5', sha: 'abc1234' });
    expect(runningImage({})).toEqual({ version: 'dev', sha: 'dev' });
  });
});
