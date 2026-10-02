-- The per-person version rate limit (VERSIONS_PER_USER_HOUR) reads a person's newest
-- versions: index them by creator and time.
CREATE INDEX "app_versions_creator_created_idx" ON "app_versions" USING btree ("created_by_user_id","created_at");
