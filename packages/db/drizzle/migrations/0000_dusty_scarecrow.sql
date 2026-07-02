CREATE TYPE "public"."app_status" AS ENUM('live', 'hibernated');--> statement-breakpoint
CREATE TYPE "public"."app_visibility" AS ENUM('public', 'team', 'password');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('workspace-admin', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."routing_mode" AS ENUM('spa', 'exact');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"active_deploy_id" text,
	"routing_mode" "routing_mode" DEFAULT 'spa' NOT NULL,
	"visibility" "app_visibility" DEFAULT 'public' NOT NULL,
	"password_hash" text,
	"status" "app_status" DEFAULT 'live' NOT NULL,
	"uses_end_user_auth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "blob_refs" (
	"sha256" text NOT NULL,
	"deploy_id" text NOT NULL,
	CONSTRAINT "blob_refs_sha256_deploy_id_pk" PRIMARY KEY("sha256","deploy_id")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploy_files" (
	"deploy_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "deploy_files_deploy_id_path_pk" PRIMARY KEY("deploy_id","path")
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"lint_report" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"google_sub" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_active_deploy_id_deploys_id_fk" FOREIGN KEY ("active_deploy_id") REFERENCES "public"."deploys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_refs" ADD CONSTRAINT "blob_refs_deploy_id_deploys_id_fk" FOREIGN KEY ("deploy_id") REFERENCES "public"."deploys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_files" ADD CONSTRAINT "deploy_files_deploy_id_deploys_id_fk" FOREIGN KEY ("deploy_id") REFERENCES "public"."deploys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_files" ADD CONSTRAINT "deploy_files_sha256_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_workspace_slug_uq" ON "apps" USING btree ("workspace_id","slug");