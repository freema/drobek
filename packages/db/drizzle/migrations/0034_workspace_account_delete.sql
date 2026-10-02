-- Deleting a workspace or an account: a deleted account's versions, audit
-- rows and registered upstreams stay and lose their author (SET NULL), and a
-- deleted workspace's audit rows stay until the retention prune (no foreign
-- key on audit_log.workspace_id).
ALTER TABLE "app_versions" DROP CONSTRAINT "app_versions_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "upstreams" DROP CONSTRAINT "upstreams_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;