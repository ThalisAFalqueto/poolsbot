CREATE TABLE IF NOT EXISTS "pool_volume_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"date" date NOT NULL,
	"volume_usd" double precision NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pool_volume_history_pool_id_date_idx" ON "pool_volume_history" USING btree ("pool_id","date");