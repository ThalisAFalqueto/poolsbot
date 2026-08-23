CREATE TABLE IF NOT EXISTS "closed_lp_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text NOT NULL,
	"token_id" text NOT NULL,
	"label" text,
	"token0_symbol" text NOT NULL,
	"token1_symbol" text NOT NULL,
	"opened_at" timestamp NOT NULL,
	"closed_at" timestamp DEFAULT now() NOT NULL,
	"entry_value_token1" double precision NOT NULL,
	"final_position_value_token1" double precision NOT NULL,
	"final_fees_value_token1" double precision NOT NULL,
	"hodl_value_token1" double precision NOT NULL,
	"il_token1" double precision NOT NULL,
	"total_pnl_token1" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_entry_value_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_position_value_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_fees_value_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_hodl_value_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_il_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_total_pnl_token1" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_known_entry_date" timestamp;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "last_snapshot_at" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "closed_lp_positions" ADD CONSTRAINT "closed_lp_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "closed_lp_positions_user_id_idx" ON "closed_lp_positions" USING btree ("user_id");