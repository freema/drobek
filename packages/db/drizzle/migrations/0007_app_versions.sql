-- M0-02 (NSO-281): immutable app versions replace the upload/deploy pipeline.
--
-- EXPLICIT, DESTRUCTIVE: the deploy pipeline tables are dropped and their
-- history is NOT migrated (decided in the M0 plan). Apps, collections,
-- documents, errors, stats, upstreams and the audit log are kept. Blob bytes
-- move from the disk volume into Postgres (`blobs.bytes`); the old on-disk
-- BLOB_DIR contents are no longer read by anything. See CHANGELOG.md.
ALTER TABLE "apps" DROP CONSTRAINT "apps_active_deploy_id_deploys_id_fk";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "active_deploy_id";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "routing_mode";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "uses_end_user_auth";--> statement-breakpoint
DROP TABLE "blob_refs";--> statement-breakpoint
DROP TABLE "deploy_files";--> statement-breakpoint
DROP TABLE "deploys";--> statement-breakpoint
DROP TABLE "blobs";--> statement-breakpoint
DROP TYPE "public"."deploy_state";--> statement-breakpoint
DROP TYPE "public"."routing_mode";--> statement-breakpoint
DROP INDEX "apps_workspace_slug_uq";--> statement-breakpoint
-- App slugs become GLOBALLY unique host labels (`<slug>.<APPS_DOMAIN>`):
-- 3–40 chars of ^[a-z0-9]+(-[a-z0-9]+)*$, no reserved word. Existing slugs
-- that break the grammar, are reserved, or collide with an OLDER app's slug
-- in another workspace are renamed to `<base>-<4hex>` (deterministic from the
-- app id; the oldest app keeps a contested slug).
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  attempt int;
BEGIN
  FOR r IN
    SELECT id, slug FROM (
      SELECT id, slug,
             row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS rank
      FROM apps
    ) ranked
    WHERE rank > 1
       OR slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       OR char_length(slug) NOT BETWEEN 3 AND 40
       OR slug IN ('www', 'api', 'mcp', 'preview', 'admin', 'mail', 'static', 'app', 'auth', 'oauth')
    ORDER BY id
  LOOP
    base := trim(both '-' from regexp_replace(lower(r.slug), '[^a-z0-9]+', '-', 'g'));
    base := trim(trailing '-' from left(base, 35));
    IF base = '' THEN base := 'app'; END IF;
    attempt := 0;
    LOOP
      candidate := base || '-' || substr(md5(r.id || attempt::text), 1, 4);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM apps WHERE slug = candidate);
      attempt := attempt + 1;
    END LOOP;
    UPDATE apps SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE TYPE "public"."compile_status" AS ENUM('pending', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."version_file_kind" AS ENUM('source', 'built');--> statement-breakpoint
CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"number" integer NOT NULL,
	"created_by_user_id" text,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"reasoning" text,
	"compile_status" "compile_status" DEFAULT 'pending' NOT NULL,
	"compile_errors" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "version_files" (
	"version_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"kind" "version_file_kind" NOT NULL,
	CONSTRAINT "version_files_version_id_kind_path_pk" PRIMARY KEY("version_id","kind","path")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "published_version_id" text;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_published_version_id_app_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."app_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_files" ADD CONSTRAINT "version_files_version_id_app_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."app_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_files" ADD CONSTRAINT "version_files_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_versions_app_number_uq" ON "app_versions" USING btree ("app_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_uq" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "apps_workspace_idx" ON "apps" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "version_files_sha256_idx" ON "version_files" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_slug_format" CHECK ("apps"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("apps"."slug") BETWEEN 3 AND 40);
