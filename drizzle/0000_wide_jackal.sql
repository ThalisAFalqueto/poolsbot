CREATE TYPE "public"."alert_metric" AS ENUM('apy_drop_relative', 'apy_below_absolute', 'tvl_drop_relative', 'tvl_below_absolute', 'reward_apy_ending', 'il_risk_proxy');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('ok', 'triggered');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"watched_pool_id" integer NOT NULL,
	"metric" "alert_metric" NOT NULL,
	"threshold_value" double precision NOT NULL,
	"window_hours" integer,
	"reminder_interval_hours" integer DEFAULT 6 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_rule_id" integer NOT NULL,
	"status" "alert_status" DEFAULT 'ok' NOT NULL,
	"last_value" double precision,
	"triggered_at" timestamp,
	"last_notified_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"il_risk" text,
	"il7d" double precision,
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
 ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_watched_pool_id_watched_pools_id_fk" FOREIGN KEY ("watched_pool_id") REFERENCES "public"."watched_pools"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_alert_rule_id_alert_rules_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watched_pools" ADD CONSTRAINT "watched_pools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_rules_watched_pool_id_idx" ON "alert_rules" USING btree ("watched_pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_state_alert_rule_id_idx" ON "alert_state" USING btree ("alert_rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apy_history_pool_id_recorded_at_idx" ON "apy_history" USING btree ("pool_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_telegram_chat_id_idx" ON "users" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watched_pools_user_id_pool_id_idx" ON "watched_pools" USING btree ("user_id","pool_id");