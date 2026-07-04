CREATE TYPE "public"."upstream_auth_type" AS ENUM('none', 'bearer', 'header');--> statement-breakpoint
CREATE TABLE "upstream_secrets" (
	"upstream_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"kek_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstreams" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"allowed_methods" text[] NOT NULL,
	"allowed_path_prefixes" text[] NOT NULL,
	"auth_type" "upstream_auth_type" DEFAULT 'none' NOT NULL,
	"auth_header_name" text,
	"allowed_app_ids" text[] DEFAULT '{}' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upstream_secrets" ADD CONSTRAINT "upstream_secrets_upstream_id_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstreams" ADD CONSTRAINT "upstreams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upstreams_workspace_name_uq" ON "upstreams" USING btree ("workspace_id","name");