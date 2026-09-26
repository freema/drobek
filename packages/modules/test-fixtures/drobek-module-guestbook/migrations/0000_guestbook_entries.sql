-- drobek-module-guestbook: one row per entry. An external module's tables
-- are mod_guestbook / mod_guestbook_* only and may reference apps(id) — the
-- start-time lint of DROBEK_MODULES_DIR modules refuses anything else.
CREATE TABLE IF NOT EXISTS "mod_guestbook_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_guestbook_entries" ADD CONSTRAINT "mod_guestbook_entries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_guestbook_entries_app_idx" ON "mod_guestbook_entries" USING btree ("app_id", "id");
