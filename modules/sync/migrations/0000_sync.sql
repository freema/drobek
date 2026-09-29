-- drobek-module-sync: the state of each configured source of each app (the
-- source itself lives in the app's module config) and the history of its
-- runs. `running_until` is the lease of a run in flight (one run of a source
-- at a time, across replicas); `paused_at` is set after too many failed runs
-- in a row (the owner resumes it, or a changed source config / a successful
-- run clears it); `config_hash` names the source config the counters belong
-- to. Rows cascade with the app.
CREATE TABLE IF NOT EXISTS "mod_sync_sources" (
	"app_id" text NOT NULL,
	"source" text NOT NULL,
	"config_hash" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_records" integer,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"running_until" timestamp with time zone,
	CONSTRAINT "mod_sync_sources_pk" PRIMARY KEY ("app_id","source")
);
--> statement-breakpoint
ALTER TABLE "mod_sync_sources" ADD CONSTRAINT "mod_sync_sources_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"source" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"records" integer,
	"inserted" integer,
	"updated" integer,
	"deleted" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "mod_sync_runs" ADD CONSTRAINT "mod_sync_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_sync_runs_app_started_idx" ON "mod_sync_runs" USING btree ("app_id","started_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_sync_runs_app_source_started_idx" ON "mod_sync_runs" USING btree ("app_id","source","started_at" DESC);
