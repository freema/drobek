-- drobek-module-forms: every stored form submission of every app. `data` is
-- the submitted fields (end-user PII: read only by the app's admins, never
-- logged). `ip_hash` is a keyed HMAC of the visitor IP (not reversible
-- without the server key), `user_id` the signed-in end user (if any),
-- `notified_at` when the notification e-mail went out. Rows cascade with the
-- app.
CREATE TABLE IF NOT EXISTS "mod_forms_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"form" text NOT NULL,
	"data" jsonb NOT NULL,
	"ip_hash" text,
	"user_id" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_forms_submissions" ADD CONSTRAINT "mod_forms_submissions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_forms_submissions_app_form_created_idx" ON "mod_forms_submissions" USING btree ("app_id","form","created_at" DESC,"id" DESC);
