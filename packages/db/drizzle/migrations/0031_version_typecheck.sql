-- NSO-388: the background TypeScript check of a version (readiness warnings);
-- null = not checked yet, or nothing to check.
ALTER TABLE "app_versions" ADD COLUMN "typecheck" jsonb;
