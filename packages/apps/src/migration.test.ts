/**
 * Migration 0007 against a database in today's production shape (0000–0006
 * applied, deploy-pipeline data present), and against an empty one.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '@drobek/db/schema';
import { migrateTo, migrationsUpTo } from './test/db.js';

const open: PGlite[] = [];
afterAll(async () => {
  for (const pg of open) await pg.close();
});

function newDb() {
  const pg = new PGlite();
  open.push(pg);
  return Object.assign(drizzle(pg, { schema }), { pg });
}

async function tables(db: ReturnType<typeof newDb>): Promise<string[]> {
  const res = await db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`
  );
  return res.rows.map((r) => r.table_name);
}

describe('migration 0007 (app versions)', () => {
  it('applies to an empty database', async () => {
    const db = newDb();
    await migrateTo(db);
    const t = await tables(db);
    expect(t).toEqual(expect.arrayContaining(['apps', 'app_versions', 'version_files', 'blobs']));
    expect(t).not.toContain('deploys');
  });

  it('applies to a production-shaped database: drops the pipeline, keeps apps + data, fixes slugs', async () => {
    const db = newDb();
    await migrateTo(db, migrationsUpTo(6));
    // Multi-statement seed → PGlite's simple-query exec.
    await db.pg.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'a@example.test');
      INSERT INTO workspaces (id, kind, slug, name) VALUES
        ('w1', 'personal', 'alice', 'Alice'), ('w2', 'team', 'bob', 'Bob');
      INSERT INTO apps (id, workspace_id, slug, created_at) VALUES
        ('a-old', 'w1', 'todo', '2026-07-01'),
        ('a-dup', 'w2', 'todo', '2026-07-02'),
        ('a-res', 'w1', 'app', '2026-07-03'),
        ('a-short', 'w2', 'ab', '2026-07-04'),
        ('a-ok', 'w2', 'crm-lite', '2026-07-05');
      INSERT INTO deploys (id, app_id, manifest, state) VALUES ('d1', 'a-old', '[]', 'ready');
      UPDATE apps SET active_deploy_id = 'd1' WHERE id = 'a-old';
      INSERT INTO blobs (sha256, content_type, size, path) VALUES ('s1', 'text/html', 3, 's1');
      INSERT INTO deploy_files (deploy_id, path, sha256) VALUES ('d1', 'index.html', 's1');
      INSERT INTO blob_refs (sha256, deploy_id) VALUES ('s1', 'd1');
      INSERT INTO collections (id, app_id, name, json_schema) VALUES ('c1', 'a-dup', 'todos', '{}');
      INSERT INTO audit_log (id, workspace_id, action, target) VALUES ('l1', 'w1', 'deploy.activate', 'todo');
    `);

    await migrateTo(db);

    const t = await tables(db);
    for (const gone of ['deploys', 'deploy_files', 'blob_refs']) expect(t).not.toContain(gone);
    expect(t).toEqual(expect.arrayContaining(['app_versions', 'version_files', 'blobs', 'collections']));

    const slugs = Object.fromEntries(
      (await db.execute<{ id: string; slug: string }>(sql`SELECT id, slug FROM apps`)).rows.map((r) => [
        r.id,
        r.slug,
      ])
    );
    expect(slugs['a-old']).toBe('todo'); // the oldest app keeps a contested slug
    expect(slugs['a-dup']).toMatch(/^todo-[0-9a-f]{4}$/);
    expect(slugs['a-res']).toMatch(/^app-[0-9a-f]{4}$/);
    expect(slugs['a-short']).toMatch(/^ab-[0-9a-f]{4}$/);
    expect(slugs['a-ok']).toBe('crm-lite');
    expect(new Set(Object.values(slugs)).size).toBe(5);

    // Data and the audit trail survive; the old pointer columns are gone.
    const cols = (
      await db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'apps'`
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toContain('published_version_id');
    for (const gone of ['active_deploy_id', 'routing_mode', 'uses_end_user_auth']) expect(cols).not.toContain(gone);
    expect((await db.execute(sql`SELECT 1 FROM collections WHERE app_id = 'a-dup'`)).rows).toHaveLength(1);
    expect((await db.execute(sql`SELECT 1 FROM audit_log WHERE id = 'l1'`)).rows).toHaveLength(1);
  });
});
