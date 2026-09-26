-- drobek-module-auth 0001 (NSO-348): sign-in providers. A user row now
-- records how the account is linked: `provider` = 'email' (the e-mail code —
-- every existing row) or the id of an `auth.provider` contribution (OIDC,
-- SAML, …) with `subject` = the IdP's stable id of the person. One IdP
-- identity maps to one user per app (partial unique index); an e-mail row is
-- linked in place (same id) on its first provider sign-in with a verified
-- address.
ALTER TABLE "mod_auth_users" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'email' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mod_auth_users" ADD COLUMN IF NOT EXISTS "subject" text;
--> statement-breakpoint
ALTER TABLE "mod_auth_users" ADD CONSTRAINT "mod_auth_users_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9]{1,15}$' AND (("provider" = 'email') = ("subject" IS NULL)));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mod_auth_users_app_provider_subject_uq" ON "mod_auth_users" USING btree ("app_id","provider","subject") WHERE "subject" IS NOT NULL;
