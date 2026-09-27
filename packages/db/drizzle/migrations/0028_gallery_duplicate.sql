-- NSO-340: duplicating a gallery app. The owner opts in per app
-- (gallery_allow_duplicate); a copy remembers its source (id, and the slug
-- for when the source is deleted). Additive only.
ALTER TABLE "apps" ADD COLUMN "gallery_allow_duplicate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "duplicated_from_app_id" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "duplicated_from_slug" text;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_duplicated_from_app_id_apps_id_fk" FOREIGN KEY ("duplicated_from_app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_duplicated_from_idx" ON "apps" USING btree ("duplicated_from_app_id") WHERE "apps"."duplicated_from_app_id" IS NOT NULL;