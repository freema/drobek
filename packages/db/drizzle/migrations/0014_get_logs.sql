-- NSO-290 (M1-07): get_logs — the compile history (app_compiles) and the
-- per-module request counters (module_request_stats). Additive only.
CREATE TABLE "app_compiles" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version_number" integer,
	"ok" boolean NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"trigger" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_request_stats" (
	"app_id" text NOT NULL,
	"module" text NOT NULL,
	"status_class" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "module_request_stats_app_id_module_status_class_day_pk" PRIMARY KEY("app_id","module","status_class","day")
);
--> statement-breakpoint
ALTER TABLE "app_compiles" ADD CONSTRAINT "app_compiles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_request_stats" ADD CONSTRAINT "module_request_stats_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_compiles_app_created_idx" ON "app_compiles" USING btree ("app_id","created_at");