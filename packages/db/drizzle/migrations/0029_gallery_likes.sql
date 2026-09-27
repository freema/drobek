-- NSO-340: gallery likes (one per signed-in account and app) and opens through
-- the gallery's counting link (per app and UTC day, no visitor data).
CREATE TABLE "gallery_likes" (
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_likes_app_id_user_id_pk" PRIMARY KEY("app_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "gallery_opens" (
	"app_id" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "gallery_opens_app_id_day_pk" PRIMARY KEY("app_id","day")
);
--> statement-breakpoint
ALTER TABLE "gallery_likes" ADD CONSTRAINT "gallery_likes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_likes" ADD CONSTRAINT "gallery_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_opens" ADD CONSTRAINT "gallery_opens_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;