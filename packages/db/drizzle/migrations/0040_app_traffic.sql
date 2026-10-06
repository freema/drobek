-- NSO-454: app traffic analytics — page views, a daily unique-visitor estimate
-- and bot views per app and UTC day, plus the top page paths and referrer hosts.
CREATE TYPE "public"."app_traffic_kind" AS ENUM('path', 'referrer');--> statement-breakpoint
CREATE TABLE "app_traffic_daily" (
	"app_id" text NOT NULL,
	"day" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	"bot_views" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_traffic_daily_app_id_day_pk" PRIMARY KEY("app_id","day")
);
--> statement-breakpoint
CREATE TABLE "app_traffic_top" (
	"app_id" text NOT NULL,
	"day" text NOT NULL,
	"kind" "app_traffic_kind" NOT NULL,
	"key" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "app_traffic_top_app_id_day_kind_key_pk" PRIMARY KEY("app_id","day","kind","key")
);
--> statement-breakpoint
ALTER TABLE "app_traffic_daily" ADD CONSTRAINT "app_traffic_daily_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_traffic_top" ADD CONSTRAINT "app_traffic_top_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_traffic_daily_day_idx" ON "app_traffic_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "app_traffic_top_day_idx" ON "app_traffic_top" USING btree ("day");