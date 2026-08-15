CREATE TABLE IF NOT EXISTS "lp_position_il_alert_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"lp_position_id" integer NOT NULL,
	"status" "alert_status" DEFAULT 'ok' NOT NULL,
	"triggered_at" timestamp,
	"last_notified_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lp_position_il_alert_state" ADD CONSTRAINT "lp_position_il_alert_state_lp_position_id_lp_positions_id_fk" FOREIGN KEY ("lp_position_id") REFERENCES "public"."lp_positions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_position_il_alert_state_lp_position_id_idx" ON "lp_position_il_alert_state" USING btree ("lp_position_id");