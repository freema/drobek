-- NSO-366: PUBLISH_APPROVAL=approval — a super-admin decides per workspace
-- whether it may publish. `publish_approved_at` null = not approved; the
-- approval request columns dedupe the operator e-mail. Upgrade: every
-- workspace that already has a published app is approved now, so turning
-- approval on never takes the next publish of a live app away.
ALTER TABLE "workspaces" ADD COLUMN "publish_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "publish_approved_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "publish_approval_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "publish_approval_requested_by" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_publish_approved_by_users_id_fk" FOREIGN KEY ("publish_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_publish_approval_requested_by_users_id_fk" FOREIGN KEY ("publish_approval_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "workspaces" SET "publish_approved_at" = now()
WHERE "id" IN (SELECT "workspace_id" FROM "apps" WHERE "published_version_id" IS NOT NULL AND "deleted_at" IS NULL);
