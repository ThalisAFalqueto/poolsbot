ALTER TABLE "lp_position_state" ADD COLUMN "near_edge_notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "near_edge_alerts" boolean DEFAULT false NOT NULL;