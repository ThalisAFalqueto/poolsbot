DROP INDEX IF EXISTS "lp_positions_token_id_chain_idx";--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "protocol" text DEFAULT 'v3' NOT NULL;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "protocol" text DEFAULT 'v3' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_positions_token_id_chain_idx" ON "lp_positions" USING btree ("token_id","chain","protocol");