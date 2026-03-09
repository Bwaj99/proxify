CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"controller_id" uuid NOT NULL,
	"public_key_pem" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"org_id" uuid,
	"controller_id" uuid,
	"agent_id" uuid,
	"actor_agent_id" uuid,
	"target_agent_id" uuid,
	"escrow_id" uuid,
	"tx_id" uuid,
	"amount_cents" integer,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "controllers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_agent_id" uuid NOT NULL,
	"to_agent_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text,
	"status" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"released_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ledger_txs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"counterparty_agent_id" uuid,
	"escrow_id" uuid,
	"note" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"max_tx_cents" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" integer NOT NULL
);
