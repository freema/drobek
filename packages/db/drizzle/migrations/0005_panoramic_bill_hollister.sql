CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'agent');--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_kind" "audit_actor_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_type" text;--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");