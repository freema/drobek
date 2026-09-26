-- NSO-362: assets honour publish. `app_assets` becomes the draft (what the
-- preview host serves); `app_version_assets` holds the set a publish froze for
-- a version (what the production host serves), `app_versions.assets_frozen_at`
-- marks a version that has one. Upgrade: the assets of every published app are
-- frozen as its live version's set, so nothing a public URL serves today
-- disappears; they stay the draft too.
CREATE TABLE "app_version_assets" (
	"version_id" text NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_version_assets_version_id_name_pk" PRIMARY KEY("version_id","name")
);
--> statement-breakpoint
ALTER TABLE "app_versions" ADD COLUMN "assets_frozen_at" timestamp;--> statement-breakpoint
ALTER TABLE "app_version_assets" ADD CONSTRAINT "app_version_assets_version_id_app_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."app_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_version_assets" ADD CONSTRAINT "app_version_assets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_version_assets_app_idx" ON "app_version_assets" USING btree ("app_id");--> statement-breakpoint
INSERT INTO "app_version_assets" ("version_id", "app_id", "name", "content_type", "size", "sha256", "storage_key", "updated_at")
SELECT a."published_version_id", aa."app_id", aa."name", aa."content_type", aa."size", aa."sha256", aa."storage_key", aa."updated_at"
FROM "app_assets" aa JOIN "apps" a ON a."id" = aa."app_id"
WHERE a."published_version_id" IS NOT NULL;--> statement-breakpoint
UPDATE "app_versions" SET "assets_frozen_at" = now()
WHERE "id" IN (SELECT "published_version_id" FROM "apps" WHERE "published_version_id" IS NOT NULL);
