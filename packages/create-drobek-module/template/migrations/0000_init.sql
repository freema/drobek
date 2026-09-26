-- {{package}}: the items of an app (one row per item).
-- Module tables are named `mod_{{module}}_*` and reference apps(id) with
-- ON DELETE CASCADE, so deleting an app deletes its module data.
CREATE TABLE IF NOT EXISTS "mod_{{module}}_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_{{module}}_items" ADD CONSTRAINT "mod_{{module}}_items_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_{{module}}_items_app_idx" ON "mod_{{module}}_items" USING btree ("app_id");
