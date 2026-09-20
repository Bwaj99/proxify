CREATE TABLE "nonces" (
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nonces_agent_id_nonce_pk" PRIMARY KEY("agent_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"audit_event_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_status_valid" CHECK ("webhook_deliveries"."status" in ('PENDING','DELIVERED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "controllers" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "controllers" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "escrows" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "escrows" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "escrows" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'public'
                AND table_name = 'idempotency_keys'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "ledger_txs" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "ledger_txs" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ledger_txs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "amount_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "policies" ALTER COLUMN "max_tx_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "policies" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "policies" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "balance_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_agent_id_key_pk" PRIMARY KEY("agent_id","key");--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "response_status" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "daily_limit_cents" bigint;--> statement-breakpoint
ALTER TABLE "nonces" ADD CONSTRAINT "nonces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nonces_seen_at_idx" ON "nonces" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_controller_id_controllers_id_fk" FOREIGN KEY ("controller_id") REFERENCES "public"."controllers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controllers" ADD CONSTRAINT "controllers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_txs" ADD CONSTRAINT "ledger_txs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_seq_idx" ON "audit_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "audit_org_seq_idx" ON "audit_events" USING btree ("org_id","seq");--> statement-breakpoint
CREATE INDEX "audit_agent_seq_idx" ON "audit_events" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE INDEX "audit_actor_seq_idx" ON "audit_events" USING btree ("actor_agent_id","seq");--> statement-breakpoint
CREATE INDEX "escrows_from_idx" ON "escrows" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "escrows_to_idx" ON "escrows" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "ledger_agent_created_idx" ON "ledger_txs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "intents_from_idx" ON "payment_intents" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "intents_to_idx" ON "payment_intents" USING btree ("to_agent_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_status_valid" CHECK ("agents"."status" in ('ACTIVE','SUSPENDED'));--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_amount_positive" CHECK ("escrows"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_status_valid" CHECK ("escrows"."status" in ('LOCKED','RELEASED','REFUNDED'));--> statement-breakpoint
ALTER TABLE "ledger_txs" ADD CONSTRAINT "ledger_amount_positive" CHECK ("ledger_txs"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "intents_amount_positive" CHECK ("payment_intents"."amount_cents" > 0);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "intents_status_valid" CHECK ("payment_intents"."status" in ('CREATED','CAPTURED','CANCELLED','EXPIRED'));--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_max_tx_positive" CHECK ("policies"."max_tx_cents" > 0);--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_daily_positive" CHECK ("policies"."daily_limit_cents" is null or "policies"."daily_limit_cents" > 0);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_non_negative" CHECK ("wallets"."balance_cents" >= 0);