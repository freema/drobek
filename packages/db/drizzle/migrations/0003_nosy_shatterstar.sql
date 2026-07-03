CREATE TYPE "public"."collection_access_mode" AS ENUM('public-read', 'public-write', 'locked', 'owner-only');--> statement-breakpoint
CREATE TABLE "app_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"collection" text NOT NULL,
	"owner_end_user_id" text,
	"doc" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"json_schema" jsonb NOT NULL,
	"access_mode" "collection_access_mode" DEFAULT 'locked' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_documents" ADD CONSTRAINT "app_documents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_documents_app_collection_idx" ON "app_documents" USING btree ("app_id","collection");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_app_name_uq" ON "collections" USING btree ("app_id","name");