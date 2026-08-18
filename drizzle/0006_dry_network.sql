CREATE TABLE IF NOT EXISTS "job_status" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp NOT NULL,
	"last_success" boolean NOT NULL,
	"last_summary" text,
	"last_error_message" text
);
