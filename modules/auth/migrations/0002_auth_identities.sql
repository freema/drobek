-- drobek-module-auth 0002 (NSO-360): external identities scoped to their
-- issuer. A provider identity is (app, provider, issuer, subject) — OIDC
-- Core §5.7: the same subject from another issuer is another person — in its
-- own table, bound to one local user. The subjects linked under 0001 carry no
-- issuer: they move here with `issuer` NULL and are claimed once, by the same
-- provider + subject asserting the user's own verified address (the module
-- refuses any other claim). `mod_auth_users.subject` goes; `provider` stays
-- as the method the account is linked to.
CREATE TABLE IF NOT EXISTS "mod_auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"issuer" text,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "mod_auth_identities_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9]{1,15}$' AND "provider" <> 'email')
);
--> statement-breakpoint
ALTER TABLE "mod_auth_identities" ADD CONSTRAINT "mod_auth_identities_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mod_auth_identities" ADD CONSTRAINT "mod_auth_identities_user_id_mod_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mod_auth_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_auth_identities_key_uq" ON "mod_auth_identities" USING btree ("app_id","provider","issuer","subject") WHERE "issuer" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_auth_identities_legacy_uq" ON "mod_auth_identities" USING btree ("app_id","provider","subject") WHERE "issuer" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_auth_identities_user_provider_uq" ON "mod_auth_identities" USING btree ("user_id","provider");
--> statement-breakpoint
INSERT INTO "mod_auth_identities" ("id", "app_id", "user_id", "provider", "issuer", "subject", "created_at", "last_login_at")
SELECT 'ei_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 24), "app_id", "id", "provider", NULL, "subject", "created_at", "last_login_at"
FROM "mod_auth_users"
WHERE "subject" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "mod_auth_users" DROP CONSTRAINT IF EXISTS "mod_auth_users_provider_check";
--> statement-breakpoint
DROP INDEX IF EXISTS "mod_auth_users_app_provider_subject_uq";
--> statement-breakpoint
ALTER TABLE "mod_auth_users" DROP COLUMN IF EXISTS "subject";
--> statement-breakpoint
ALTER TABLE "mod_auth_users" ADD CONSTRAINT "mod_auth_users_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9]{1,15}$');
