CREATE TYPE "public"."lp_position_status" AS ENUM('in_range', 'out_of_range');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lp_position_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"lp_position_id" integer NOT NULL,
	"status" "lp_position_status" DEFAULT 'in_range' NOT NULL,
	"out_of_range_since" timestamp,
	"last_notified_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lp_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text DEFAULT 'arbitrum' NOT NULL,
	"token_id" text NOT NULL,
	"pool_address" text NOT NULL,
	"token0_address" text NOT NULL,
	"token1_address" text NOT NULL,
	"token0_symbol" text NOT NULL,
	"token1_symbol" text NOT NULL,
	"token0_decimals" integer NOT NULL,
	"token1_decimals" integer NOT NULL,
	"fee" integer NOT NULL,
	"tick_lower" integer NOT NULL,
	"tick_upper" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lp_position_state" ADD CONSTRAINT "lp_position_state_lp_position_id_lp_positions_id_fk" FOREIGN KEY ("lp_position_id") REFERENCES "public"."lp_positions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lp_positions" ADD CONSTRAINT "lp_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_position_state_lp_position_id_idx" ON "lp_position_state" USING btree ("lp_position_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_positions_token_id_chain_idx" ON "lp_positions" USING btree ("token_id","chain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_positions_user_id_idx" ON "lp_positions" USING btree ("user_id");