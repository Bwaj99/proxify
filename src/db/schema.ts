import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Money is always integer cents. bigint (mode:number) is exact up to 2^53-1,
 * which the API enforces; the CHECK constraints below are the last line of
 * defence if application code ever gets it wrong.
 */
const cents = (name: string) => bigint(name, { mode: "number" });
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const controllers = pgTable("controllers", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  displayName: text("display_name").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id),
    controllerId: uuid("controller_id").notNull().references(() => controllers.id),
    publicKeyPem: text("public_key_pem").notNull(),
    /** SUSPENDED agents fail authentication: an operator kill-switch. */
    status: text("status").notNull().default("ACTIVE"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("agents_status_valid", sql`${t.status} in ('ACTIVE','SUSPENDED')`),
    index("agents_org_idx").on(t.orgId),
  ],
);

export const wallets = pgTable(
  "wallets",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id),
    balanceCents: cents("balance_cents").notNull(),
  },
  (t) => [check("wallets_non_negative", sql`${t.balanceCents} >= 0`)],
);

export const policies = pgTable(
  "policies",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id),
    maxTxCents: cents("max_tx_cents").notNull(),
    /** Rolling 24h spend cap across transfers and escrow locks. NULL = unlimited. */
    dailyLimitCents: cents("daily_limit_cents"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("policies_max_tx_positive", sql`${t.maxTxCents} > 0`),
    check("policies_daily_positive", sql`${t.dailyLimitCents} is null or ${t.dailyLimitCents} > 0`),
  ],
);

export const ledgerTxs = pgTable(
  "ledger_txs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    type: text("type").notNull(), // FUND | TRANSFER_OUT | TRANSFER_IN | ESCROW_LOCK | ESCROW_RELEASE | ESCROW_REFUND
    amountCents: cents("amount_cents").notNull(),
    counterpartyAgentId: uuid("counterparty_agent_id"),
    escrowId: uuid("escrow_id"),
    note: text("note"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("ledger_amount_positive", sql`${t.amountCents} > 0`),
    index("ledger_agent_created_idx").on(t.agentId, t.createdAt),
  ],
);

export const escrows = pgTable(
  "escrows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id),
    amountCents: cents("amount_cents").notNull(),
    note: text("note"),
    status: text("status").notNull(), // LOCKED -> RELEASED (payer) | REFUNDED (worker)
    createdAt: tstz("created_at").notNull().defaultNow(),
    releasedAt: tstz("released_at"),
  },
  (t) => [
    check("escrows_amount_positive", sql`${t.amountCents} > 0`),
    check("escrows_status_valid", sql`${t.status} in ('LOCKED','RELEASED','REFUNDED')`),
    index("escrows_from_idx").on(t.fromAgentId),
    index("escrows_to_idx").on(t.toAgentId),
  ],
);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id),
    amountCents: cents("amount_cents").notNull(),
    note: text("note"),
    status: text("status").notNull(), // CREATED -> CAPTURED | CANCELLED | EXPIRED
    createdAt: tstz("created_at").notNull().defaultNow(),
    capturedAt: tstz("captured_at"),
    expiresAt: tstz("expires_at"),
  },
  (t) => [
    check("intents_amount_positive", sql`${t.amountCents} > 0`),
    check("intents_status_valid", sql`${t.status} in ('CREATED','CAPTURED','CANCELLED','EXPIRED')`),
    index("intents_from_idx").on(t.fromAgentId),
    index("intents_to_idx").on(t.toAgentId),
  ],
);

/**
 * Append-only (UPDATE/DELETE/TRUNCATE are rejected by a trigger, see the
 * audit_immutable migration). `seq` gives a stable total order for cursors.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    orgId: uuid("org_id"),
    controllerId: uuid("controller_id"),
    agentId: uuid("agent_id"),
    actorAgentId: uuid("actor_agent_id"),
    targetAgentId: uuid("target_agent_id"),
    escrowId: uuid("escrow_id"),
    txId: uuid("tx_id"),
    amountCents: cents("amount_cents"),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("audit_seq_idx").on(t.seq),
    index("audit_org_seq_idx").on(t.orgId, t.seq),
    index("audit_agent_seq_idx").on(t.agentId, t.seq),
    index("audit_actor_seq_idx").on(t.actorAgentId, t.seq),
  ],
);

/** Replay protection: a (agent, nonce) pair can be consumed exactly once. Shared across instances. */
export const nonces = pgTable(
  "nonces",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    nonce: text("nonce").notNull(),
    seenAt: tstz("seen_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.nonce] }), index("nonces_seen_at_idx").on(t.seenAt)],
);

/** Scoped per agent. `requestHash` makes key reuse with a different request an error, not a silent replay. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull().default(""),
    responseStatus: integer("response_status").notNull().default(200),
    responseJson: jsonb("response_json").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.key] })],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => orgs.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(), // HMAC key; shown once at creation
    active: boolean("active").notNull().default(true),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [index("webhook_endpoints_org_idx").on(t.orgId)],
);

/** Transactional outbox: rows are written in the same transaction as the audit event that caused them. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id),
    auditEventId: uuid("audit_event_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | DELIVERED | FAILED
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: tstz("created_at").notNull().defaultNow(),
    deliveredAt: tstz("delivered_at"),
  },
  (t) => [
    check("webhook_deliveries_status_valid", sql`${t.status} in ('PENDING','DELIVERED','FAILED')`),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
  ],
);
