-- token1_address adicionada como nullable + backfill + SET NOT NULL (não
-- direto NOT NULL) porque closed_lp_positions já tem 1 linha real em
-- produção (a posição WBTC/USDC #5658859, arquivada durante essa mesma
-- sessão) — endereço do USDC na Arbitrum confirmado on-chain (token1() do
-- pool 0x0E4831319A50228B9e450861297aB92dee15B44F), não digitado de
-- memória.
ALTER TABLE "closed_lp_positions" ADD COLUMN "token1_address" text;--> statement-breakpoint
UPDATE "closed_lp_positions" SET "token1_address" = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' WHERE "token1_address" IS NULL AND "chain" = 'arbitrum' AND "token1_symbol" = 'USDC';--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ALTER COLUMN "token1_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "mint_gas_native" double precision;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "mint_gas_tx_hash" text;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "close_gas_native" double precision;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "close_gas_tx_hashes" text;--> statement-breakpoint
ALTER TABLE "closed_lp_positions" ADD COLUMN "native_gas_symbol" text;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "mint_gas_native" double precision;--> statement-breakpoint
ALTER TABLE "lp_positions" ADD COLUMN "mint_gas_tx_hash" text;