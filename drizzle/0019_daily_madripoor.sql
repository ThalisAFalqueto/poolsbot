ALTER TABLE "closed_lp_positions" ADD COLUMN "receipt_source" text;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "fees_amount0" double precision;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "fees_amount1" double precision;