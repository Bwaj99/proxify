CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp NOT NULL
);
