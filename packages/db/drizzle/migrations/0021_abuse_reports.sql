-- NSO-293 (M4-02): abuse and moderation — the abuse_reports queue (public
-- report form + publish heuristic flags) and apps.locked_reason (super-admin
-- takedown). Additive only.
CREATE TYPE "public"."abuse_report_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "abuse_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text,
	"host" text NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"reporter_email" text,
	"ip_hash" text,
	"status" "abuse_report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" text
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "locked_reason" text;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_reports_status_created_idx" ON "abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "abuse_reports_app_idx" ON "abuse_reports" USING btree ("app_id");