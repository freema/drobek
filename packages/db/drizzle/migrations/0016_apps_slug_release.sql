-- NSO-288 (M2-01): dashboard app delete. A soft-deleted app keeps its slug for
-- 30 days; then @drobek/apps (releaseDeletedAppSlugs) renames it to the
-- tombstone `<slug>~deleted-<id>` so a new app can take the slug. The slug
-- CHECK admits that tombstone on deleted rows only; the partial index serves
-- the release sweep. Additive for live rows (their grammar is unchanged).
ALTER TABLE "apps" DROP CONSTRAINT "apps_slug_format";--> statement-breakpoint
CREATE INDEX "apps_deleted_at_idx" ON "apps" USING btree ("deleted_at") WHERE "apps"."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_slug_format" CHECK (("apps"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("apps"."slug") BETWEEN 3 AND 40) OR ("apps"."deleted_at" IS NOT NULL AND "apps"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*~deleted-[a-z0-9]+$'));
