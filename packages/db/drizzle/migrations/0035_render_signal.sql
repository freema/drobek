-- NSO-437: the beacon also reports failed resource loads and CSP blocks, every
-- report carries the version its page was served from, and page loads are
-- counted per version (a count only).
ALTER TYPE "public"."app_error_type" ADD VALUE 'resource';--> statement-breakpoint
ALTER TYPE "public"."app_error_type" ADD VALUE 'csp';--> statement-breakpoint
CREATE TABLE "app_version_loads" (
	"app_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"page_loads" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_version_loads_app_id_version_number_pk" PRIMARY KEY("app_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "app_errors" ADD COLUMN "version_number" integer;--> statement-breakpoint
ALTER TABLE "app_version_loads" ADD CONSTRAINT "app_version_loads_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
