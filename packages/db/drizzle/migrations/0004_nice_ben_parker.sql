CREATE TYPE "public"."app_error_type" AS ENUM('error', 'unhandledrejection');--> statement-breakpoint
CREATE TABLE "app_daily_stats" (
	"app_id" text NOT NULL,
	"day" text NOT NULL,
	"path_404_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"count_5xx" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_daily_stats_app_id_day_pk" PRIMARY KEY("app_id","day")
);
--> statement-breakpoint
CREATE TABLE "app_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"type" "app_error_type" NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"url" text NOT NULL,
	"ua" text,
	"ts" timestamp,
	"dedup_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_daily_stats" ADD CONSTRAINT "app_daily_stats_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_errors" ADD CONSTRAINT "app_errors_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_errors_app_created_idx" ON "app_errors" USING btree ("app_id","created_at");