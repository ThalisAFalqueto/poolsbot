ALTER TYPE "public"."alert_metric" ADD VALUE 'volume_spike_relative';--> statement-breakpoint
ALTER TABLE "apy_history" ADD COLUMN "volume_usd" double precision;