-- NSO-414: an access token records the refresh token it was issued with, so
-- refresh reuse revokes the access tokens of that rotation lineage only.
ALTER TABLE "oauth_access_tokens" ADD COLUMN "refresh_token_id" text;--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_refresh_token_idx" ON "oauth_access_tokens" USING btree ("refresh_token_id");
