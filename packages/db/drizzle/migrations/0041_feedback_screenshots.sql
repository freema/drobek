-- A screenshot on a feedback note: the re-encoded image lives in blobs (the
-- blob GC counts the reference); the note keeps its sha256, size and dimensions.
ALTER TABLE "app_feedback" ADD COLUMN "screenshot_sha256" text;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "screenshot_width" integer;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "screenshot_height" integer;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD COLUMN "screenshot_bytes" integer;--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_screenshot_sha256_blobs_sha256_fk" FOREIGN KEY ("screenshot_sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_feedback_screenshot_sha256_idx" ON "app_feedback" USING btree ("screenshot_sha256");