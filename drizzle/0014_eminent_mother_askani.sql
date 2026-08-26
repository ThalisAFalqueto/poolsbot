CREATE TYPE "public"."cash_flow_direction" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_cash_flows" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"chain" text NOT NULL,
	"unique_id" text NOT NULL,
	"direction" "cash_flow_direction" NOT NULL,
	"asset" text NOT NULL,
	"amount" double precision NOT NULL,
	"value_usdc" double precision NOT NULL,
	"tx_hash" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_nav_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"chain" text NOT NULL,
	"date" date NOT NULL,
	"nav_usdc" double precision NOT NULL,
	"idle_usdc" double precision NOT NULL,
	"positions_usdc" double precision NOT NULL,
	"fees_usdc" double precision NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_cash_flows" ADD CONSTRAINT "wallet_cash_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_nav_snapshots" ADD CONSTRAINT "wallet_nav_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_cash_flows_unique_id_idx" ON "wallet_cash_flows" USING btree ("unique_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_cash_flows_user_occurred_at_idx" ON "wallet_cash_flows" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_nav_snapshots_wallet_date_idx" ON "wallet_nav_snapshots" USING btree ("user_id","wallet_address","chain","date");