/**
 * Auth migration 0002 against a database in the v0.2.x shape
 * (0000–0001 applied, e-mail and provider-linked users present).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import auth from './index.js';
import { authIdentities, authUsers } from './schema.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const AUTH_MIGRATIONS = auth.migrations!.folder as string;
const TABLE = { migrationsTable: '__drizzle_migrations_mod_auth', migrationsSchema: 'drizzle' };

const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const f of cleanup) await f();
});

/** The auth migrations folder cut after entry `last` (a copy with a shorter journal). */
function folderUpTo(last: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'drobek-auth-mig-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const journal = JSON.parse(readFileSync(join(AUTH_MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  mkdirSync(join(dir, 'meta'));
  const entries = journal.entries.filter((e) => e.idx <= last);
  for (const e of entries) copyFileSync(join(AUTH_MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return dir;
}

describe('auth migration 0002 (identities scoped to their issuer)', () => {
  it('moves every linked subject into mod_auth_identities (issuer unknown → NULL), keeps users and ids, drops mod_auth_users.subject', async () => {
    const pg = new PGlite();
    cleanup.push(() => pg.close());
    const db = drizzle(pg, { schema });
    await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
    await migrate(db, { migrationsFolder: folderUpTo(1), ...TABLE });
    await pg.exec(`
      INSERT INTO workspaces (id, kind, slug, name) VALUES ('w1', 'team', 'mig-ws', 'Mig');
      INSERT INTO apps (id, workspace_id, slug) VALUES ('a1', 'w1', 'mig-app'), ('a2', 'w1', 'mig-two');
      INSERT INTO mod_auth_users (id, app_id, email, role, provider, subject, created_at, last_login_at) VALUES
        ('eu_000000000000000000000001', 'a1', 'mail@example.com', 'user', 'email', NULL, '2026-09-01', '2026-09-02'),
        ('eu_000000000000000000000002', 'a1', 'sso@example.com', 'admin', 'oidc', 'sub-1', '2026-09-03', '2026-09-04'),
        ('eu_000000000000000000000003', 'a2', 'sso@example.com', 'user', 'oidc', 'sub-1', '2026-09-05', NULL);
    `);

    await migrate(db, { migrationsFolder: AUTH_MIGRATIONS, ...TABLE });

    const users = await db.select().from(authUsers).orderBy(authUsers.id);
    expect(users.map((u) => [u.id, u.appId, u.email, u.role, u.provider])).toEqual([
      ['eu_000000000000000000000001', 'a1', 'mail@example.com', 'user', 'email'],
      ['eu_000000000000000000000002', 'a1', 'sso@example.com', 'admin', 'oidc'],
      ['eu_000000000000000000000003', 'a2', 'sso@example.com', 'user', 'oidc'],
    ]);
    const cols = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'mod_auth_users' ORDER BY 1`
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain('subject');

    const identities = await db.select().from(authIdentities).orderBy(authIdentities.userId);
    expect(identities.map((i) => [i.appId, i.userId, i.provider, i.issuer, i.subject])).toEqual([
      ['a1', 'eu_000000000000000000000002', 'oidc', null, 'sub-1'],
      ['a2', 'eu_000000000000000000000003', 'oidc', null, 'sub-1'],
    ]);
    expect(identities[0].id).toMatch(/^ei_[0-9a-f]{24}$/);
    expect(identities[0].createdAt.toISOString()).toBe(new Date('2026-09-03').toISOString());

    // the provider check stays; a user's identities go with the user, and with the app
    await expect(pg.exec(`INSERT INTO mod_auth_users (id, app_id, email, provider) VALUES ('eu_x', 'a1', 'x@example.com', 'Bad!')`)).rejects.toThrow();
    await pg.exec(`DELETE FROM mod_auth_users WHERE id = 'eu_000000000000000000000002'`);
    await pg.exec(`DELETE FROM apps WHERE id = 'a2'`);
    expect(await db.select().from(authIdentities)).toEqual([]);
  });

  it('applies to an empty database', async () => {
    const pg = new PGlite();
    cleanup.push(() => pg.close());
    const db = drizzle(pg, { schema });
    await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
    await migrate(db, { migrationsFolder: AUTH_MIGRATIONS, ...TABLE });
    expect(await db.select().from(authIdentities)).toEqual([]);
  });
});
