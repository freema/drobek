CREATE TYPE "public"."deploy_state" AS ENUM('awaiting_upload', 'queued', 'linting', 'storing', 'activating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "state" "deploy_state" DEFAULT 'awaiting_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "total_bytes" bigint;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "activated_at" timestamp;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;