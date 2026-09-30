-- drobek-module-acme-crm: the contacts of an app (one row per address).
-- Module tables are named `mod_acmecrm_*` and reference apps(id) with
-- ON DELETE CASCADE, so deleting an app deletes its module data.
CREATE TABLE IF NOT EXISTS "mod_acmecrm_contacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"source" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_acmecrm_contacts" ADD CONSTRAINT "mod_acmecrm_contacts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_acmecrm_contacts_app_email_idx" ON "mod_acmecrm_contacts" USING btree ("app_id","email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_acmecrm_contacts_app_idx" ON "mod_acmecrm_contacts" USING btree ("app_id");
