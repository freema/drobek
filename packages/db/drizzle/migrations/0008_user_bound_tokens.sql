-- M0-04 (NSO-282): OAuth tokens become USER-bound; API keys; CIMD/DCR client
-- bookkeeping.
--
-- EXPLICIT, DESTRUCTIVE: every authorization code, access token and refresh
-- token is deleted — they were bound to one workspace + role and used the old
-- scope vocabulary (mcp:whoami, apps:read, deploy:write, data:read,
-- data:write), which nothing accepts any more. Connected agents simply
-- reconnect (new consent → read / write / publish). Registered clients are
-- kept; the ones that ever held a grant are stamped as used so they do not
-- count toward the unused-DCR-client cap. See CHANGELOG.md.
ALTER TABLE "oauth_clients" ADD COLUMN "source" text DEFAULT 'dcr' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
UPDATE "oauth_clients" c SET "last_used_at" = c."created_at"
 WHERE EXISTS (SELECT 1 FROM "oauth_authorization_codes" a WHERE a."client_id" = c."client_id")
    OR EXISTS (SELECT 1 FROM "oauth_access_tokens" t WHERE t."oauth_client_id" = c."id")
    OR EXISTS (SELECT 1 FROM "oauth_refresh_tokens" r WHERE r."oauth_client_id" = c."id");--> statement-breakpoint
TRUNCATE TABLE "oauth_authorization_codes", "oauth_access_tokens", "oauth_refresh_tokens";--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" DROP CONSTRAINT "oauth_access_tokens_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" DROP CONSTRAINT "oauth_authorization_codes_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" DROP CONSTRAINT "oauth_refresh_tokens_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" DROP COLUMN "role";
