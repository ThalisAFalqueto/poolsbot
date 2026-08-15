CREATE TABLE IF NOT EXISTS "lp_position_il_baseline" (
	"id" serial PRIMARY KEY NOT NULL,
	"lp_position_id" integer NOT NULL,
	"liquidity" text NOT NULL,
	"sqrt_price_x96" text NOT NULL,
	"tick" integer NOT NULL,
	"was_reset" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lp_position_il_baseline" ADD CONSTRAINT "lp_position_il_baseline_lp_position_id_lp_positions_id_fk" FOREIGN KEY ("lp_position_id") REFERENCES "public"."lp_positions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_position_il_baseline_lp_position_id_idx" ON "lp_position_il_baseline" USING btree ("lp_position_id");