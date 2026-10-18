-- A screenshot an agent asked for and a person captured on the preview: the
-- re-encoded image lives in blobs (the blob GC counts the reference); the row
-- keeps the request id, version, page, note, size and dimensions.
CREATE TABLE "app_screenshots" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version_number" integer,
	"path" text,
	"note" text,
	"requested_by_user_id" text,
	"browser" text,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"requested_at" timestamp NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_screenshots" ADD CONSTRAINT "app_screenshots_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_screenshots" ADD CONSTRAINT "app_screenshots_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_screenshots" ADD CONSTRAINT "app_screenshots_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_screenshots_app_captured_idx" ON "app_screenshots" USING btree ("app_id","captured_at");--> statement-breakpoint
CREATE INDEX "app_screenshots_captured_idx" ON "app_screenshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "app_screenshots_sha256_idx" ON "app_screenshots" USING btree ("sha256");