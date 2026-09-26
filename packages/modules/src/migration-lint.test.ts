import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintMigrationSql, lintModuleMigrations } from './migration-lint.js';
import { GUESTBOOK_FIXTURE } from './test/modules-dir.js';

const lint = (sql: string) => lintMigrationSql('crm', sql).map((i) => `${i.line}: ${i.message}`);

describe('migration lint (DROBEK_MODULES_DIR modules)', () => {
  it('passes drizzle-kit output that stays in the module namespace', () => {
    expect(lintModuleMigrations('guestbook', join(GUESTBOOK_FIXTURE, 'migrations'))).toEqual([]);
    expect(
      lint(`
CREATE TYPE "public"."mod_crm_stage" AS ENUM('lead', 'won');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_crm" ("id" text PRIMARY KEY NOT NULL, "workspace_id" text NOT NULL REFERENCES workspaces(id));
CREATE TABLE "public"."mod_crm_deals" (
  "id" bigserial PRIMARY KEY,
  "app_id" text NOT NULL,
  "crm_id" text REFERENCES "mod_crm"("id"),
  "stage" "mod_crm_stage" DEFAULT 'lead'
);
ALTER TABLE "mod_crm_deals" ADD CONSTRAINT "mod_crm_deals_app_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mod_crm_deals" ALTER COLUMN "stage" DROP DEFAULT;
ALTER TABLE "mod_crm_deals" DROP COLUMN IF EXISTS "legacy";
CREATE UNIQUE INDEX IF NOT EXISTS "mod_crm_deals_idx" ON "mod_crm_deals" USING btree ("app_id", "id");
CREATE INDEX ON mod_crm_deals (stage);
DO $$ BEGIN
 ALTER TABLE "mod_crm_deals" ADD CONSTRAINT "x" FOREIGN KEY ("crm_id") REFERENCES "public"."mod_crm"("id");
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DROP INDEX IF EXISTS "mod_crm_old_idx";
TRUNCATE mod_crm_deals;
DROP TABLE IF EXISTS "mod_crm_tmp", mod_crm_tmp2;
-- a comment may say DROP TABLE apps; or CREATE FUNCTION x()
INSERT INTO "mod_crm" ("id", "workspace_id") VALUES ('DROP TABLE apps', 'w');
COMMENT ON TABLE "mod_crm" IS 'CREATE EXTENSION nope';
`)
    ).toEqual([]);
  });

  it('refuses tables and indexes outside mod_<name>[_*], with the line', () => {
    expect(lint('CREATE TABLE "users" (id text);')).toEqual(['1: "users" is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('\n\nCREATE TABLE mod_crmx (id text);')).toEqual(['3: mod_crmx is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('CREATE INDEX "mod_crm_i" ON "apps" ("slug");')).toEqual(['1: "apps" is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('CREATE TABLE "drizzle"."mod_crm_x" (id text);')).toEqual(['1: "drizzle"."mod_crm_x" is outside the public schema']);
    expect(lint('CREATE VIEW "app_list" AS SELECT 1;')).toHaveLength(1);
  });

  it('refuses REFERENCES to foreign tables (only its own, apps(id), workspaces(id))', () => {
    expect(lint('CREATE TABLE mod_crm_a (u text REFERENCES "public"."users"("id"));')).toEqual([
      '1: REFERENCES "public"."users"("id"): a module may reference only its own tables, apps(id) or workspaces(id)',
    ]);
    expect(lint('CREATE TABLE mod_crm_a (s text REFERENCES apps(slug));')).toHaveLength(1);
  });

  it('refuses DROP / ALTER / TRUNCATE of foreign tables', () => {
    expect(lint('DROP TABLE "apps";')).toEqual(['1: DROP TABLE: "apps" is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('DROP TABLE mod_crm_a, users;')).toEqual(['1: DROP TABLE: users is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('ALTER TABLE "public"."apps" ADD COLUMN "x" text;')).toHaveLength(1);
    expect(lint('TRUNCATE TABLE "versions";')).toEqual(['1: TRUNCATE: "versions" is not a table of this module (mod_crm or mod_crm_*)']);
    expect(lint('DROP INDEX "apps_slug_idx";')).toHaveLength(1);
    // Inside a DO block too.
    expect(lint('DO $$ BEGIN\n  DROP TABLE apps;\nEND $$;')).toEqual(['2: DROP TABLE: apps is not a table of this module (mod_crm or mod_crm_*)']);
  });

  it('refuses functions, triggers, extensions, schemas, roles, grants', () => {
    expect(lint('CREATE OR REPLACE FUNCTION mod_crm_f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;')).toEqual([
      '1: CREATE FUNCTION is not allowed in a module migration',
    ]);
    expect(lint('CREATE TRIGGER t AFTER INSERT ON mod_crm_a FOR EACH ROW EXECUTE FUNCTION f();')).toEqual(['1: CREATE TRIGGER is not allowed in a module migration']);
    expect(lint('CREATE EXTENSION IF NOT EXISTS pgcrypto;')).toEqual(['1: CREATE EXTENSION is not allowed in a module migration']);
    expect(lint('CREATE SCHEMA crm;')).toEqual(['1: CREATE SCHEMA is not allowed in a module migration']);
    expect(lint('CREATE TABLE mod_crm_a (id text);\nDROP SCHEMA public CASCADE;')).toEqual(['2: DROP SCHEMA is not allowed in a module migration']);
    expect(lint('ALTER ROLE drobek SUPERUSER;')).toEqual(['1: ALTER ROLE is not allowed in a module migration']);
    expect(lint('GRANT ALL ON mod_crm_a TO public;')).toEqual(['1: GRANT is not allowed in a module migration']);
  });

  it('reports every issue of a folder with its file', () => {
    const issues = lintMigrationSql('guestbook', readFileSync(join(GUESTBOOK_FIXTURE, 'migrations/0000_guestbook_entries.sql'), 'utf8').replace('"public"."apps"', '"public"."users"'), '0000.sql');
    expect(issues).toEqual([
      { file: '0000.sql', line: 12, message: expect.stringMatching(/^REFERENCES "public"\."users"\("id"\)/) },
    ]);
  });
});
