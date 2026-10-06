-- Feedback on the app preview: notes signed-in members leave on what they saw
-- on a preview or version host; the agent lists and resolves them over MCP.
CREATE TYPE "public"."feedback_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "app_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version_number" integer,
	"path" text NOT NULL,
	"anchor" jsonb,
	"body" text NOT NULL,
	"author_user_id" text,
	"status" "feedback_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_user_id" text,
	"resolved_by_kind" "audit_actor_kind",
	"resolution_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_feedback_app_status_created_idx" ON "app_feedback" USING btree ("app_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "app_feedback_author_created_idx" ON "app_feedback" USING btree ("author_user_id","created_at");