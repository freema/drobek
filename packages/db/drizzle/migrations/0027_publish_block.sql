-- NSO-366: a super-admin can turn publishing off for a workspace, in every
-- PUBLISH_APPROVAL mode. Blocked = publish_blocked_at set; allowed =
-- publish_approved_at set (0026); neither = the server mode decides.
ALTER TABLE "workspaces" ADD COLUMN "publish_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "publish_blocked_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_publish_blocked_by_users_id_fk" FOREIGN KEY ("publish_blocked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
