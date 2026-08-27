CREATE TABLE IF NOT EXISTS "market_volume_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"volume_usd" double precision NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watched_pairs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pair_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watched_pairs" ADD CONSTRAINT "watched_pairs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "market_volume_history_date_idx" ON "market_volume_history" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watched_pairs_user_id_pair_key_idx" ON "watched_pairs" USING btree ("user_id","pair_key");