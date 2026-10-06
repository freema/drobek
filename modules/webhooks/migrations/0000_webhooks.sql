-- drobek-module-webhooks: what happened to each delivery to an app's webhook
-- endpoints (the endpoints themselves live in the app's module config), and
-- the sender event ids already stored (dedupe). A delivery row never holds
-- the body, a header or a secret: the stored payload is a record of the
-- app's data collection. `reason` is the module's own short code. Rows
-- cascade with the app; the daily prune job removes deliveries older than
-- 30 days and expired event ids.
CREATE TABLE IF NOT EXISTS "mod_webhooks_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer NOT NULL,
	"bytes" integer NOT NULL,
	"reason" text,
	"record_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_webhooks_deliveries" ADD CONSTRAINT "mod_webhooks_deliveries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_webhooks_deliveries_app_received_idx" ON "mod_webhooks_deliveries" USING btree ("app_id","received_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_webhooks_deliveries_received_idx" ON "mod_webhooks_deliveries" USING btree ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_webhooks_events" (
	"app_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"event_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mod_webhooks_events_pk" PRIMARY KEY ("app_id","endpoint","event_id")
);
--> statement-breakpoint
ALTER TABLE "mod_webhooks_events" ADD CONSTRAINT "mod_webhooks_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mod_webhooks_events_expires_idx" ON "mod_webhooks_events" USING btree ("expires_at");
