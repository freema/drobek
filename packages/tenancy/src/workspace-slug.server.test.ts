/**
 * A taken workspace slug through the REAL error path (NSO-333): PGlite with
 * the core migrations, the workspaces.slug UNIQUE constraint and whatever
 * error shape the installed drizzle-orm throws (≥ 0.44 wraps the driver error
 * in a DrizzleQueryError whose own `code` is undefined).
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDbForTests, users } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { ensurePersonalWorkspace } from './personal-workspace.server.js';
import { createTeamWorkspace } from './team-workspace.server.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function user(email: string): Promise<string> {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return u.id;
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

describe('workspace slug collisions', () => {
  it('a taken team slug is slug-taken, not a 500', async () => {
    const owner = await user('team-owner@example.test');
    const first = await createTeamWorkspace(owner, 'Acme', 'acme-team');
    expect(first.ok).toBe(true);

    const other = await user('rival@example.test');
    const second = await createTeamWorkspace(other, 'Acme again', 'acme-team');
    expect(second).toEqual({ ok: false, reason: 'slug-taken', message: 'That slug is already taken. Pick another one.' });
  });

  it('a personal slug taken by an unrelated workspace retries with the next suffix', async () => {
    const squatter = await user('squatter@example.test');
    expect((await createTeamWorkspace(squatter, 'Jana', 'jana')).ok).toBe(true);

    const jana = await user('jana@example.test');
    const ws = await ensurePersonalWorkspace(jana, 'jana@example.test');
    expect(ws).toMatchObject({ kind: 'personal', slug: 'jana-2' });
    // Idempotent: the second call finds it.
    expect(await ensurePersonalWorkspace(jana, 'jana@example.test')).toEqual(ws);
  });
});
