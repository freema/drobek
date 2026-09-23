-- drobek-module-data: every record of every app. `doc` holds the record's own
-- fields (never the server's `_…` fields), `owner_id` the signed-in end user
-- who created it (null for an anonymous create), `bytes` its JSON size (the
-- per-app quota sums it). Rows cascade with the app.
CREATE TABLE IF NOT EXISTS "mod_data_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"collection" text NOT NULL,
	"owner_id" text,
	"doc" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every statement of this file is re-runnable (the import below included).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mod_data_documents_app_id_apps_id_fk') THEN
    ALTER TABLE "mod_data_documents" ADD CONSTRAINT "mod_data_documents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_data_documents_app_collection_created_idx" ON "mod_data_documents" USING btree ("app_id","collection","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_data_documents_app_collection_owner_idx" ON "mod_data_documents" USING btree ("app_id","collection","owner_id");
--> statement-breakpoint
-- The pre-module Data API (core tables `collections` + `app_documents`, core
-- migrations 0003–0012): every collection whose name is a valid collection
-- name becomes a declared collection of the app's data config (its JSON
-- Schema kept, its access_mode mapped to per-operation rules), every live
-- document of it a record (soft-deleted documents are not carried over);
-- then the old tables and enum are dropped. A no-op on a fresh database.
DO $$
BEGIN
  IF to_regclass('public.collections') IS NOT NULL THEN
    INSERT INTO "module_configs" ("app_id", "module", "config")
    SELECT c."app_id", 'data', jsonb_build_object('collections', jsonb_object_agg(c."name", jsonb_build_object(
      'schema', c."json_schema",
      'rules', CASE c."access_mode"::text
        WHEN 'public-read' THEN '{"read":"public","create":"admin","update":"admin","delete":"admin"}'::jsonb
        WHEN 'public-write' THEN '{"read":"public","create":"public","update":"admin","delete":"admin"}'::jsonb
        WHEN 'owner-only' THEN '{"read":"owner|admin","create":"user","update":"owner|admin","delete":"owner|admin"}'::jsonb
        ELSE '{"read":"admin","create":"admin","update":"admin","delete":"admin"}'::jsonb
      END)))
    FROM "collections" c
    WHERE c."name" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
    GROUP BY c."app_id"
    ON CONFLICT ("app_id", "module") DO UPDATE SET
      "config" = "module_configs"."config" || jsonb_build_object('collections',
        coalesce("module_configs"."config" -> 'collections', '{}'::jsonb) || (EXCLUDED."config" -> 'collections')),
      "updated_at" = now();

    IF to_regclass('public.app_documents') IS NOT NULL THEN
      INSERT INTO "mod_data_documents" ("id", "app_id", "collection", "owner_id", "doc", "bytes", "created_at", "updated_at")
      SELECT d."id", d."app_id", d."collection", d."owner_end_user_id",
        CASE WHEN jsonb_typeof(d."doc") = 'object' THEN d."doc" - '_id' - '_owner' - '_created_at' - '_updated_at' ELSE '{}'::jsonb END,
        octet_length(d."doc"::text),
        d."created_at" AT TIME ZONE 'UTC', d."updated_at" AT TIME ZONE 'UTC'
      FROM "app_documents" d
      JOIN "collections" c ON c."app_id" = d."app_id" AND c."name" = d."collection"
      WHERE d."deleted_at" IS NULL AND c."name" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
      ON CONFLICT ("id") DO NOTHING;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "app_documents";
--> statement-breakpoint
DROP TABLE IF EXISTS "collections";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."collection_access_mode";
