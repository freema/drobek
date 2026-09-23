-- drobek-module-hello: the waves an app's visitors sent (one row per wave).
-- Module tables are prefixed `mod_<module>_` and reference apps(id) with
-- ON DELETE CASCADE, so deleting an app deletes its module data.
CREATE TABLE IF NOT EXISTS "mod_hello_waves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_hello_waves" ADD CONSTRAINT "mod_hello_waves_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_hello_waves_app_idx" ON "mod_hello_waves" USING btree ("app_id");
