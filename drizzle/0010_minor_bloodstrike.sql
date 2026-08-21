CREATE TABLE IF NOT EXISTS "pool_price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"pool_address" text NOT NULL,
	"recorded_at" timestamp NOT NULL,
	"price" double precision NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pool_price_history_pool_recorded_at_idx" ON "pool_price_history" USING btree ("chain","pool_address","recorded_at");