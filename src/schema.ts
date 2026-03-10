import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const controllers = pgTable("controllers", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  controllerId: uuid("controller_id").notNull(),
  publicKeyPem: text("public_key_pem").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const wallets = pgTable("wallets", {
  agentId: uuid("agent_id").primaryKey(),
  balanceCents: integer("balance_cents").notNull(),
});

export const policies = pgTable("policies", {
  agentId: uuid("agent_id").primaryKey(),
  maxTxCents: integer("max_tx_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const ledgerTxs = pgTable("ledger_txs", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  counterpartyAgentId: uuid("counterparty_agent_id"),
  escrowId: uuid("escrow_id"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const escrows = pgTable("escrows", {
  id: uuid("id").primaryKey(),
  fromAgentId: uuid("from_agent_id").notNull(),
  toAgentId: uuid("to_agent_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  note: text("note"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  eventType: text("event_type").notNull(),
  orgId: uuid("org_id"),
  controllerId: uuid("controller_id"),
  agentId: uuid("agent_id"),
  actorAgentId: uuid("actor_agent_id"),
  targetAgentId: uuid("target_agent_id"),
  escrowId: uuid("escrow_id"),
  txId: uuid("tx_id"),
  amountCents: integer("amount_cents"),
  reason: text("reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  endpoint: text("endpoint").notNull(),
  responseJson: jsonb("response_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const paymentIntents = pgTable("payment_intents", {
  id: uuid("id").primaryKey(),
  fromAgentId: uuid("from_agent_id").notNull(),
  toAgentId: uuid("to_agent_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  note: text("note"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});