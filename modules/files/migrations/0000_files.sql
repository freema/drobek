-- drobek-module-files: every uploaded file of every app. The bytes live on
-- disk under FILES_DIR at their content address (`sha256`, shared by every row
-- with the same content, any app); `type` is the SNIFFED type, `name` the
-- sanitized client file name (download name only), `owner_id` the signed-in
-- end user who uploaded it (null for an anonymous upload). The per-app quota
-- sums `size`. Rows cascade with the app (the blobs of a deleted app stay on
-- disk until swept).
CREATE TABLE IF NOT EXISTS "mod_files" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"type" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_files_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mod_files_size_check" CHECK ("size" > 0)
);
--> statement-breakpoint
ALTER TABLE "mod_files" ADD CONSTRAINT "mod_files_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_files_app_created_idx" ON "mod_files" USING btree ("app_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_files_sha256_idx" ON "mod_files" USING btree ("sha256");
