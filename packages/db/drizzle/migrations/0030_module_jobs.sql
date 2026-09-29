-- NSO-391: a failed run of a module's per-app job is kept with the app's
-- browser errors (get_logs runtime): its own type plus the module and job.
ALTER TYPE "public"."app_error_type" ADD VALUE 'module_job';--> statement-breakpoint
ALTER TABLE "app_errors" ADD COLUMN "module" text;--> statement-breakpoint
ALTER TABLE "app_errors" ADD COLUMN "job" text;
