-- NSO-358: app assets — binary files (images, video, audio, fonts) an app
-- serves at /assets/<name>; the bytes live on disk under ASSETS_DIR, the rows
-- here. Additive only.
CREATE TABLE "app_assets" (
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_assets_app_id_name_pk" PRIMARY KEY("app_id","name")
);
--> statement-breakpoint
ALTER TABLE "app_assets" ADD CONSTRAINT "app_assets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assets" ADD CONSTRAINT "app_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;