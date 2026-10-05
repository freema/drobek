-- A member can keep a version: the history retention and a clean-up leave it alone.
ALTER TABLE "app_versions" ADD COLUMN "kept_at" timestamp;--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "kept_by_user_id" text;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_kept_by_user_id_users_id_fk" FOREIGN KEY ("kept_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;