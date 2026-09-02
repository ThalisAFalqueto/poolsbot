CREATE TABLE IF NOT EXISTS "close_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text NOT NULL,
	"protocol" text DEFAULT 'v3' NOT NULL,
	"token_id" text NOT NULL,
	"below_price" double precision,
	"above_price" double precision,
	"enabled" boolean DEFAULT true NOT NULL,
	"fired_at" timestamp,
	"fired_tx_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "close_triggers" ADD CONSTRAINT "close_triggers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "close_triggers_user_chain_protocol_token_idx" ON "close_triggers" USING btree ("user_id","chain","protocol","token_id");