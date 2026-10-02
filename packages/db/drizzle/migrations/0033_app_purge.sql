-- The app purge deletes an app row APP_PURGE_AFTER_DAYS after its soft
-- delete: its versions, browser errors and daily request stats go with it
-- like every other row that references the app.
ALTER TABLE "app_daily_stats" DROP CONSTRAINT "app_daily_stats_app_id_apps_id_fk";
--> statement-breakpoint
ALTER TABLE "app_errors" DROP CONSTRAINT "app_errors_app_id_apps_id_fk";
--> statement-breakpoint
ALTER TABLE "app_versions" DROP CONSTRAINT "app_versions_app_id_apps_id_fk";
--> statement-breakpoint
ALTER TABLE "app_daily_stats" ADD CONSTRAINT "app_daily_stats_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_errors" ADD CONSTRAINT "app_errors_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;