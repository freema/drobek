-- drobek-module-auth: the end users of each app (one row per app + e-mail).
-- A row is created by the first successful sign-in (so every row is a
-- verified address). `role` mirrors the app's auth config at the last
-- sign-in / session refresh; `disabled_at` blocks sign-in and ends sessions
-- on their next refresh. Rows cascade with the app.
CREATE TABLE IF NOT EXISTS "mod_auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_auth_users_role_check" CHECK ("role" IN ('user', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "mod_auth_users" ADD CONSTRAINT "mod_auth_users_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_auth_users_app_email_uq" ON "mod_auth_users" USING btree ("app_id","email");
