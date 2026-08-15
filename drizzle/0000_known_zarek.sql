CREATE TABLE IF NOT EXISTS "alerts_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"watched_pool_id" integer NOT NULL,
	"metric" text NOT NULL,
	"threshold_value" double precision NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apy_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"chain" text NOT NULL,
	"apy_base" double precision,
	"apy_reward" double precision,
	"apy" double precision NOT NULL,
	"tvl_usd" double precision NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"wallet_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watched_pools" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pool_id" text NOT NULL,
	"chain" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts_config" ADD CONSTRAINT "alerts_config_watched_pool_id_watched_pools_id_fk" FOREIGN KEY ("watched_pool_id") REFERENCES "public"."watched_pools"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watched_pools" ADD CONSTRAINT "watched_pools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_telegram_chat_id_idx" ON "users" USING btree ("telegram_chat_id");