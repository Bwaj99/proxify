import "dotenv/config";
import express from "express";
import { randomUUID, verify } from "crypto";
import { z } from "zod";
import { and, desc, eq, or, sql } from "drizzle-orm";

import { buildMessage } from "./auth";
import { db } from "./db";
import {
  orgs,
  controllers,
  agents,
  wallets as walletsTable,
  policies as policiesTable,
  ledgerTxs as ledgerTxsTable,
  escrows as escrowsTable,
  auditEvents as auditEventsTable,
  idempotencyKeys,
  paymentIntents,
} from "./schema";

const app = express();

/**
 * Capture raw body (needed for signature verification)
 */
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf8") || "";
    },
  })
);

/**
 * Lightweight DB health check
 */
app.get("/health/db", async (_req, res) => {
  try {
    await db.execute(sql`select 1 as ok`);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("DB health check failed:", err?.message ?? err);
    return res.status(500).json({
      ok: false,
      error: "DB connection failed",
      message: err?.message ?? String(err),
    });
  }
});

/**
 * Replay protection: store (agentId -> nonce -> usedAtMs)
 * (still in-memory for now — OK for prototype)
 */
const usedNoncesByAgent = new Map<string, Map<string, number>>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupNonces(agentId: string) {
  const now = Date.now();
  const nonceMap = usedNoncesByAgent.get(agentId);
  if (!nonceMap) return;

  for (const [nonce, ts] of nonceMap.entries()) {
    if (now - ts > NONCE_TTL_MS) nonceMap.delete(nonce);
  }

  if (nonceMap.size === 0) usedNoncesByAgent.delete(agentId);
}

/**
 * Audit helper (writes to DB)
 */
async function logEvent(e: {
  eventType: string;
  orgId?: string;
  controllerId?: string;
  agentId?: string;
  actorAgentId?: string;
  targetAgentId?: string;
  escrowId?: string;
  txId?: string;
  amountCents?: number;
  reason?: string;
  metadata?: Record<string, any>;
}) {
  await db.insert(auditEventsTable).values({
    id: randomUUID(),
    eventType: e.eventType,
    orgId: e.orgId,
    controllerId: e.controllerId,
    agentId: e.agentId,
    actorAgentId: e.actorAgentId,
    targetAgentId: e.targetAgentId,
    escrowId: e.escrowId,
    txId: e.txId,
    amountCents: e.amountCents,
    reason: e.reason,
    metadata: e.metadata ?? null,
    createdAt: new Date(),
  });
}

/**
 * Auth verify helper for signed requests
 */
async function verifySignedRequestOr401(params: {
  req: any;
  res: any;
  agentId: string;
  method: string;
  path: string;
}) {
  const { req, res, agentId, method, path } = params;

  const timestamp = req.header("X-Timestamp");
  const nonce = req.header("X-Nonce");
  const signatureB64 = req.header("X-Signature");

  if (!timestamp || !nonce || !signatureB64) {
    res.status(401).json({ error: "Missing auth headers" });
    return { ok: false as const };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    res.status(401).json({ error: "Bad timestamp" });
    return { ok: false as const };
  }

  const ageMs = Math.abs(Date.now() - ts);
  if (ageMs > 2 * 60 * 1000) {
    res.status(401).json({ error: "Timestamp too old" });
    return { ok: false as const };
  }

  cleanupNonces(agentId);
  if (!usedNoncesByAgent.has(agentId)) usedNoncesByAgent.set(agentId, new Map());
  const nonceMap = usedNoncesByAgent.get(agentId)!;

  if (nonceMap.has(nonce)) {
    res.status(401).json({ error: "Replay detected (nonce already used)" });
    return { ok: false as const };
  }
  nonceMap.set(nonce, Date.now());

  const agentRow = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);

  if (!agentRow) {
    res.status(404).json({ error: "Agent not found" });
    return { ok: false as const };
  }

  const message = buildMessage(agentId, timestamp, nonce, method, path, req.rawBody ?? "");

  const valid = verify(
    null,
    Buffer.from(message, "utf8"),
    agentRow.publicKeyPem,
    Buffer.from(signatureB64, "base64")
  );

  if (!valid) {
    res.status(401).json({ error: "Invalid signature" });
    return { ok: false as const };
  }

  return { ok: true as const, agentRow };
}

/**
 * 1) Create Org
 */
app.post("/v1/orgs", async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid org name" });
    }

    const id = randomUUID();

    await db.insert(orgs).values({
      id,
      name: parsed.data.name,
      createdAt: new Date(),
    });

    await logEvent({
      eventType: "ORG_CREATED",
      orgId: id,
      metadata: { name: parsed.data.name },
    });

    return res.status(201).json({ orgId: id, name: parsed.data.name });
  } catch (err: any) {
    console.error("CREATE ORG ERROR:", err);
    return res.status(500).json({
      error: "Create org failed",
      message: err?.message ?? String(err),
    });
  }
});

/**
 * 2) Create Controller
 */
app.post("/v1/controllers", async (req, res) => {
  const schema = z.object({
    orgId: z.string().uuid(),
    displayName: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid controller data" });

  const orgRow = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, parsed.data.orgId))
    .then((r) => r[0]);

  if (!orgRow) return res.status(404).json({ error: "Org not found" });

  const id = randomUUID();

  await db.insert(controllers).values({
    id,
    orgId: parsed.data.orgId,
    displayName: parsed.data.displayName,
    createdAt: new Date(),
  });

  await logEvent({
    eventType: "CONTROLLER_CREATED",
    orgId: parsed.data.orgId,
    controllerId: id,
    metadata: { displayName: parsed.data.displayName },
  });

  return res.status(201).json({
    controllerId: id,
    orgId: parsed.data.orgId,
    displayName: parsed.data.displayName,
  });
});

/**
 * 3) Register Agent
 */
app.post("/v1/agents/register", async (req, res) => {
  const schema = z.object({
    orgId: z.string().uuid(),
    controllerId: z.string().uuid(),
    publicKeyPem: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid agent registration data" });

  const orgRow = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, parsed.data.orgId))
    .then((r) => r[0]);
  if (!orgRow) return res.status(404).json({ error: "Org not found" });

  const controllerRow = await db
    .select()
    .from(controllers)
    .where(eq(controllers.id, parsed.data.controllerId))
    .then((r) => r[0]);

  if (!controllerRow) return res.status(404).json({ error: "Controller not found" });
  if (controllerRow.orgId !== parsed.data.orgId) {
    return res.status(401).json({ error: "Controller does not belong to org" });
  }

  const agentId = randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(agents).values({
      id: agentId,
      orgId: parsed.data.orgId,
      controllerId: parsed.data.controllerId,
      publicKeyPem: parsed.data.publicKeyPem,
      createdAt: now,
    });

    await tx.insert(walletsTable).values({
      agentId,
      balanceCents: 0,
    });

    await tx.insert(policiesTable).values({
      agentId,
      maxTxCents: 5000,
      createdAt: now,
      updatedAt: now,
    });
  });

  await logEvent({
    eventType: "AGENT_REGISTERED",
    orgId: parsed.data.orgId,
    controllerId: parsed.data.controllerId,
    agentId,
  });

  return res.status(201).json({ agentId });
});

/**
 * 4) Protected route (signature + replay protection)
 */
app.post("/v1/agents/:agentId/protected", async (req: any, res) => {
  const agentId = req.params.agentId;

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId,
    method: req.method,
    path: req.path,
  });
  if (!auth.ok) return;

  return res.json({
    success: true,
    agentId,
    orgId: auth.agentRow.orgId,
    controllerId: auth.agentRow.controllerId,
  });
});

/**
 * Wallet read
 */
app.get("/v1/agents/:agentId/wallet", async (req, res) => {
  const agentId = req.params.agentId;

  const agentRow = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);
  if (!agentRow) return res.status(404).json({ error: "Agent not found" });

  const walletRow = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, agentId))
    .then((r) => r[0]);

  if (!walletRow) return res.status(404).json({ error: "Wallet not found" });

  const txs = await db
    .select()
    .from(ledgerTxsTable)
    .where(eq(ledgerTxsTable.agentId, agentId))
    .orderBy(desc(ledgerTxsTable.createdAt))
    .limit(200);

  return res.json({
    agentId,
    orgId: agentRow.orgId,
    controllerId: agentRow.controllerId,
    balanceCents: walletRow.balanceCents,
    txCount: txs.length,
    transactions: txs,
  });
});

/**
 * Wallet fund (not signed for demo simplicity)
 */
app.post("/v1/agents/:agentId/wallet/fund", async (req, res) => {
  const agentId = req.params.agentId;

  const agentRow = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);
  if (!agentRow) return res.status(404).json({ error: "Agent not found" });

  const schema = z.object({
    amountCents: z.number().int().positive(),
    note: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid fund request" });

  const txId = randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    const walletRow = await tx
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.agentId, agentId))
      .then((r) => r[0]);

    if (!walletRow) throw new Error("Wallet not found");

    await tx
      .update(walletsTable)
      .set({ balanceCents: walletRow.balanceCents + parsed.data.amountCents })
      .where(eq(walletsTable.agentId, agentId));

    await tx.insert(ledgerTxsTable).values({
      id: txId,
      agentId,
      type: "FUND",
      amountCents: parsed.data.amountCents,
      note: parsed.data.note,
      createdAt: now,
    });
  });

  await logEvent({
    eventType: "WALLET_FUNDED",
    orgId: agentRow.orgId,
    controllerId: agentRow.controllerId,
    agentId,
    actorAgentId: agentId,
    amountCents: parsed.data.amountCents,
    txId,
    metadata: { note: parsed.data.note },
  });

  const newWallet = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, agentId))
    .then((r) => r[0]);

  return res.status(201).json({
    success: true,
    agentId,
    newBalanceCents: newWallet?.balanceCents ?? null,
    txId,
  });
});

/**
 * Transfer (SIGNED) — DB transaction
 */
app.post("/v1/tx/transfer", async (req: any, res) => {
  const fromAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!fromAgentId) return res.status(401).json({ error: "Missing X-Agent-Id" });

  const idempotencyKey = req.header("Idempotency-Key") as string | undefined;
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Missing Idempotency-Key header" });
  }

  const schema = z.object({
    toAgentId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    note: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid transfer request" });

  const existingIdempotent = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, idempotencyKey))
    .then((rows) => rows[0]);

  if (existingIdempotent) {
    return res.status(200).json(existingIdempotent.responseJson);
  }

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: fromAgentId,
    method: "POST",
    path: "/v1/tx/transfer",
  });
  if (!auth.ok) return;

  const fromAgent = auth.agentRow;
  const toAgent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, parsed.data.toAgentId))
    .then((r) => r[0]);
  if (!toAgent) return res.status(404).json({ error: "To agent not found" });

  const amount = parsed.data.amountCents;
  const txOutId = randomUUID();
  const txInId = randomUUID();
  const now = new Date();

  const policyRow = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, fromAgentId))
    .then((r) => r[0]);

  if (!policyRow) return res.status(404).json({ error: "Policy not found for sender" });

  if (amount > policyRow.maxTxCents) {
    await logEvent({
      eventType: "TRANSFER_FAILED",
      orgId: fromAgent.orgId,
      controllerId: fromAgent.controllerId,
      agentId: fromAgentId,
      actorAgentId: fromAgentId,
      targetAgentId: parsed.data.toAgentId,
      amountCents: amount,
      reason: "Transfer exceeds policy maxTxCents",
      metadata: { maxTxCents: policyRow.maxTxCents, note: parsed.data.note },
    });

    return res.status(403).json({
      error: "Transfer exceeds policy maxTxCents",
      maxTxCents: policyRow.maxTxCents,
      attemptedAmountCents: amount,
    });
  }

  try {
    await db.transaction(async (tx) => {
      const fromWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, fromAgentId))
        .then((r) => r[0]);

      const toWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, parsed.data.toAgentId))
        .then((r) => r[0]);

      if (!fromWallet || !toWallet) throw new Error("Wallet not found");
      if (fromWallet.balanceCents < amount) throw new Error("Insufficient funds");

      await tx
        .update(walletsTable)
        .set({ balanceCents: fromWallet.balanceCents - amount })
        .where(eq(walletsTable.agentId, fromAgentId));

      await tx
        .update(walletsTable)
        .set({ balanceCents: toWallet.balanceCents + amount })
        .where(eq(walletsTable.agentId, parsed.data.toAgentId));

      await tx.insert(ledgerTxsTable).values({
        id: txOutId,
        agentId: fromAgentId,
        type: "TRANSFER_OUT",
        amountCents: amount,
        counterpartyAgentId: parsed.data.toAgentId,
        note: parsed.data.note,
        createdAt: now,
      });

      await tx.insert(ledgerTxsTable).values({
        id: txInId,
        agentId: parsed.data.toAgentId,
        type: "TRANSFER_IN",
        amountCents: amount,
        counterpartyAgentId: fromAgentId,
        note: parsed.data.note,
        createdAt: now,
      });
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    await logEvent({
      eventType: "TRANSFER_FAILED",
      orgId: fromAgent.orgId,
      controllerId: fromAgent.controllerId,
      agentId: fromAgentId,
      actorAgentId: fromAgentId,
      targetAgentId: parsed.data.toAgentId,
      amountCents: amount,
      reason: msg,
    });

    if (msg.includes("Insufficient funds")) return res.status(400).json({ error: "Insufficient funds" });
    if (msg.includes("Wallet not found")) return res.status(404).json({ error: "Wallet not found" });
    return res.status(500).json({ error: "Transfer failed", detail: msg });
  }

  await logEvent({
    eventType: "TRANSFER_SUCCEEDED",
    orgId: fromAgent.orgId,
    controllerId: fromAgent.controllerId,
    agentId: fromAgentId,
    actorAgentId: fromAgentId,
    targetAgentId: parsed.data.toAgentId,
    amountCents: amount,
    metadata: { txOutId, txInId, note: parsed.data.note },
  });

  const fromWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, fromAgentId))
    .then((r) => r[0]);

  const toWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, parsed.data.toAgentId))
    .then((r) => r[0]);

  const responseBody = {
    success: true,
    fromAgentId,
    toAgentId: parsed.data.toAgentId,
    amountCents: amount,
    fromNewBalanceCents: fromWalletAfter?.balanceCents ?? null,
    toNewBalanceCents: toWalletAfter?.balanceCents ?? null,
    txOutId,
    txInId,
  };

  await db.insert(idempotencyKeys).values({
    key: idempotencyKey,
    agentId: fromAgentId,
    endpoint: "/v1/tx/transfer",
    responseJson: responseBody,
    createdAt: new Date(),
  });

  return res.status(201).json(responseBody);
});

/**
 * Payment Intent create (SIGNED)
 * Creates a conditional payment instruction without immediately moving funds.
 */
app.post("/v1/intents", async (req: any, res) => {
  const fromAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!fromAgentId) return res.status(401).json({ error: "Missing X-Agent-Id" });

  const schema = z.object({
    toAgentId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    note: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payment intent request" });
  }

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: fromAgentId,
    method: "POST",
    path: "/v1/intents",
  });
  if (!auth.ok) return;

  const fromAgent = auth.agentRow;

  const toAgent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, parsed.data.toAgentId))
    .then((r) => r[0]);

  if (!toAgent) {
    return res.status(404).json({ error: "To agent not found" });
  }

  const policyRow = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, fromAgentId))
    .then((r) => r[0]);

  if (!policyRow) return res.status(404).json({ error: "Policy not found for sender" });

  if (parsed.data.amountCents > policyRow.maxTxCents) {
    await logEvent({
      eventType: "INTENT_FAILED",
      orgId: fromAgent.orgId,
      controllerId: fromAgent.controllerId,
      agentId: fromAgentId,
      actorAgentId: fromAgentId,
      targetAgentId: parsed.data.toAgentId,
      amountCents: parsed.data.amountCents,
      reason: "Intent exceeds policy maxTxCents",
      metadata: { maxTxCents: policyRow.maxTxCents, note: parsed.data.note },
    });

    return res.status(403).json({
      error: "Intent exceeds policy maxTxCents",
      maxTxCents: policyRow.maxTxCents,
      attemptedAmountCents: parsed.data.amountCents,
    });
  }

  const intentId = randomUUID();

  await db.insert(paymentIntents).values({
    id: intentId,
    fromAgentId,
    toAgentId: parsed.data.toAgentId,
    amountCents: parsed.data.amountCents,
    note: parsed.data.note ?? null,
    status: "CREATED",
    createdAt: new Date(),
    capturedAt: null,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
  });

  await logEvent({
    eventType: "INTENT_CREATED",
    orgId: fromAgent.orgId,
    controllerId: fromAgent.controllerId,
    agentId: fromAgentId,
    actorAgentId: fromAgentId,
    targetAgentId: parsed.data.toAgentId,
    amountCents: parsed.data.amountCents,
    metadata: {
      intentId,
      note: parsed.data.note ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
    },
  });

  return res.status(201).json({
    success: true,
    intent: {
      id: intentId,
      fromAgentId,
      toAgentId: parsed.data.toAgentId,
      amountCents: parsed.data.amountCents,
      note: parsed.data.note ?? null,
      status: "CREATED",
      expiresAt: parsed.data.expiresAt ?? null,
    },
  });
});

/**
 * Payment Intent read
 */
app.get("/v1/intents/:intentId", async (req, res) => {
  const intentId = req.params.intentId;

  const intent = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .then((r) => r[0]);

  if (!intent) return res.status(404).json({ error: "Intent not found" });

  return res.json(intent);
});

/**
 * Payment Intent capture (SIGNED)
 * Capturing the intent actually moves funds.
 */
app.post("/v1/intents/:intentId/capture", async (req: any, res) => {
  const intentId = req.params.intentId;

  const actorAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!actorAgentId) return res.status(401).json({ error: "Missing X-Agent-Id" });

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: actorAgentId,
    method: "POST",
    path: `/v1/intents/${intentId}/capture`,
  });
  if (!auth.ok) return;

  const actorAgent = auth.agentRow;

  const intent = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .then((r) => r[0]);

  if (!intent) return res.status(404).json({ error: "Intent not found" });

  if (actorAgentId !== intent.fromAgentId) {
    await logEvent({
      eventType: "INTENT_CAPTURE_FAILED",
      orgId: actorAgent.orgId,
      controllerId: actorAgent.controllerId,
      agentId: intent.fromAgentId,
      actorAgentId,
      targetAgentId: intent.toAgentId,
      amountCents: intent.amountCents,
      reason: "Only payer can capture intent",
      metadata: { intentId },
    });

    return res.status(403).json({
      error: "Only the payer (fromAgentId) can capture this intent",
      fromAgentId: intent.fromAgentId,
      actorAgentId,
    });
  }

  if (intent.status !== "CREATED") {
    return res.status(400).json({
      error: "Intent is not capturable",
      status: intent.status,
    });
  }

  if (intent.expiresAt && new Date(intent.expiresAt).getTime() < Date.now()) {
    await db
      .update(paymentIntents)
      .set({ status: "EXPIRED" })
      .where(eq(paymentIntents.id, intentId));

    return res.status(400).json({
      error: "Intent has expired",
      status: "EXPIRED",
    });
  }

  const policyRow = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, intent.fromAgentId))
    .then((r) => r[0]);

  if (!policyRow) return res.status(404).json({ error: "Policy not found for sender" });

  if (intent.amountCents > policyRow.maxTxCents) {
    await logEvent({
      eventType: "INTENT_CAPTURE_FAILED",
      orgId: actorAgent.orgId,
      controllerId: actorAgent.controllerId,
      agentId: intent.fromAgentId,
      actorAgentId,
      targetAgentId: intent.toAgentId,
      amountCents: intent.amountCents,
      reason: "Intent capture exceeds policy maxTxCents",
      metadata: { intentId, maxTxCents: policyRow.maxTxCents },
    });

    return res.status(403).json({
      error: "Intent capture exceeds policy maxTxCents",
      maxTxCents: policyRow.maxTxCents,
      attemptedAmountCents: intent.amountCents,
    });
  }

  const txOutId = randomUUID();
  const txInId = randomUUID();
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const fromWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, intent.fromAgentId))
        .then((r) => r[0]);

      const toWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, intent.toAgentId))
        .then((r) => r[0]);

      if (!fromWallet || !toWallet) throw new Error("Wallet not found");
      if (fromWallet.balanceCents < intent.amountCents) throw new Error("Insufficient funds");

      await tx
        .update(walletsTable)
        .set({ balanceCents: fromWallet.balanceCents - intent.amountCents })
        .where(eq(walletsTable.agentId, intent.fromAgentId));

      await tx
        .update(walletsTable)
        .set({ balanceCents: toWallet.balanceCents + intent.amountCents })
        .where(eq(walletsTable.agentId, intent.toAgentId));

      await tx.insert(ledgerTxsTable).values({
        id: txOutId,
        agentId: intent.fromAgentId,
        type: "TRANSFER_OUT",
        amountCents: intent.amountCents,
        counterpartyAgentId: intent.toAgentId,
        note: `Intent capture ${intentId}${intent.note ? ` - ${intent.note}` : ""}`,
        createdAt: now,
      });

      await tx.insert(ledgerTxsTable).values({
        id: txInId,
        agentId: intent.toAgentId,
        type: "TRANSFER_IN",
        amountCents: intent.amountCents,
        counterpartyAgentId: intent.fromAgentId,
        note: `Intent capture ${intentId}${intent.note ? ` - ${intent.note}` : ""}`,
        createdAt: now,
      });

      await tx
        .update(paymentIntents)
        .set({
          status: "CAPTURED",
          capturedAt: now,
        })
        .where(eq(paymentIntents.id, intentId));
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    await logEvent({
      eventType: "INTENT_CAPTURE_FAILED",
      orgId: actorAgent.orgId,
      controllerId: actorAgent.controllerId,
      agentId: intent.fromAgentId,
      actorAgentId,
      targetAgentId: intent.toAgentId,
      amountCents: intent.amountCents,
      reason: msg,
      metadata: { intentId },
    });

    if (msg.includes("Insufficient funds")) {
      return res.status(400).json({ error: "Insufficient funds" });
    }
    if (msg.includes("Wallet not found")) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    return res.status(500).json({ error: "Intent capture failed", detail: msg });
  }

  await logEvent({
    eventType: "INTENT_CAPTURED",
    orgId: actorAgent.orgId,
    controllerId: actorAgent.controllerId,
    agentId: intent.fromAgentId,
    actorAgentId: intent.fromAgentId,
    targetAgentId: intent.toAgentId,
    amountCents: intent.amountCents,
    metadata: { intentId, txOutId, txInId },
  });

  const fromWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, intent.fromAgentId))
    .then((r) => r[0]);

  const toWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, intent.toAgentId))
    .then((r) => r[0]);

  return res.status(201).json({
    success: true,
    intentId,
    status: "CAPTURED",
    fromAgentId: intent.fromAgentId,
    toAgentId: intent.toAgentId,
    amountCents: intent.amountCents,
    fromNewBalanceCents: fromWalletAfter?.balanceCents ?? null,
    toNewBalanceCents: toWalletAfter?.balanceCents ?? null,
    txOutId,
    txInId,
  });
});

/**
 * Payment Intent cancel (SIGNED)
 * Only the payer can cancel, and only before capture.
 */
app.post("/v1/intents/:intentId/cancel", async (req: any, res) => {
  const intentId = req.params.intentId;

  const actorAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!actorAgentId) return res.status(401).json({ error: "Missing X-Agent-Id" });

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: actorAgentId,
    method: "POST",
    path: `/v1/intents/${intentId}/cancel`,
  });
  if (!auth.ok) return;

  const actorAgent = auth.agentRow;

  const intent = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .then((r) => r[0]);

  if (!intent) return res.status(404).json({ error: "Intent not found" });

  if (actorAgentId !== intent.fromAgentId) {
    return res.status(403).json({
      error: "Only the payer (fromAgentId) can cancel this intent",
      fromAgentId: intent.fromAgentId,
      actorAgentId,
    });
  }

  if (intent.status !== "CREATED") {
    return res.status(400).json({
      error: "Intent is not cancellable",
      status: intent.status,
    });
  }

  await db
    .update(paymentIntents)
    .set({ status: "CANCELLED" })
    .where(eq(paymentIntents.id, intentId));

  await logEvent({
    eventType: "INTENT_CANCELLED",
    orgId: actorAgent.orgId,
    controllerId: actorAgent.controllerId,
    agentId: intent.fromAgentId,
    actorAgentId,
    targetAgentId: intent.toAgentId,
    amountCents: intent.amountCents,
    metadata: { intentId },
  });

  return res.status(200).json({
    success: true,
    intentId,
    status: "CANCELLED",
  });
});

/**
 * Policy get
 */
app.get("/v1/agents/:agentId/policy", async (req, res) => {
  const agentId = req.params.agentId;

  const agentRow = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);
  if (!agentRow) return res.status(404).json({ error: "Agent not found" });

  const policyRow = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, agentId))
    .then((r) => r[0]);
  if (!policyRow) return res.status(404).json({ error: "Policy not found" });

  return res.json({
    agentId: policyRow.agentId,
    maxTxCents: policyRow.maxTxCents,
    createdAt: policyRow.createdAt,
    updatedAt: policyRow.updatedAt,
  });
});

/**
 * Policy set (not signed for demo simplicity)
 */
app.post("/v1/agents/:agentId/policy", async (req, res) => {
  const agentId = req.params.agentId;

  const agentRow = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);
  if (!agentRow) return res.status(404).json({ error: "Agent not found" });

  const schema = z.object({ maxTxCents: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid policy" });

  const now = new Date();

  const existing = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, agentId))
    .then((r) => r[0]);

  if (!existing) {
    await db.insert(policiesTable).values({
      agentId,
      maxTxCents: parsed.data.maxTxCents,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(policiesTable)
      .set({ maxTxCents: parsed.data.maxTxCents, updatedAt: now })
      .where(eq(policiesTable.agentId, agentId));
  }

  await logEvent({
    eventType: "POLICY_UPDATED",
    orgId: agentRow.orgId,
    controllerId: agentRow.controllerId,
    agentId,
    actorAgentId: agentId,
    metadata: { maxTxCents: parsed.data.maxTxCents },
  });

  return res.status(201).json({
    success: true,
    agentId,
    maxTxCents: parsed.data.maxTxCents,
  });
});

/**
 * Escrow create (SIGNED) — DB transaction
 */
app.post("/v1/escrows", async (req: any, res) => {
  const fromAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!fromAgentId) return res.status(401).json({ error: "Missing X-Agent-Id" });

  const schema = z.object({
    toAgentId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    note: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid escrow request" });

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: fromAgentId,
    method: "POST",
    path: "/v1/escrows",
  });
  if (!auth.ok) return;

  const fromAgent = auth.agentRow;

  const toAgent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, parsed.data.toAgentId))
    .then((r) => r[0]);
  if (!toAgent) return res.status(404).json({ error: "To agent not found" });

  const amount = parsed.data.amountCents;

  const policyRow = await db
    .select()
    .from(policiesTable)
    .where(eq(policiesTable.agentId, fromAgentId))
    .then((r) => r[0]);

  if (!policyRow) return res.status(404).json({ error: "Policy not found for sender" });
  if (amount > policyRow.maxTxCents) {
    await logEvent({
      eventType: "TRANSFER_FAILED",
      orgId: fromAgent.orgId,
      controllerId: fromAgent.controllerId,
      agentId: fromAgentId,
      actorAgentId: fromAgentId,
      targetAgentId: parsed.data.toAgentId,
      amountCents: amount,
      reason: "Escrow exceeds policy maxTxCents",
      metadata: { maxTxCents: policyRow.maxTxCents, note: parsed.data.note },
    });

    return res.status(403).json({
      error: "Escrow exceeds policy maxTxCents",
      maxTxCents: policyRow.maxTxCents,
      attemptedAmountCents: amount,
    });
  }

  const escrowId = randomUUID();
  const txLockId = randomUUID();
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const fromWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, fromAgentId))
        .then((r) => r[0]);

      if (!fromWallet) throw new Error("Wallet not found");
      if (fromWallet.balanceCents < amount) throw new Error("Insufficient funds");

      await tx.insert(escrowsTable).values({
        id: escrowId,
        fromAgentId,
        toAgentId: parsed.data.toAgentId,
        amountCents: amount,
        note: parsed.data.note,
        status: "LOCKED",
        createdAt: now,
        releasedAt: null,
      });

      await tx
        .update(walletsTable)
        .set({ balanceCents: fromWallet.balanceCents - amount })
        .where(eq(walletsTable.agentId, fromAgentId));

      await tx.insert(ledgerTxsTable).values({
        id: txLockId,
        agentId: fromAgentId,
        type: "ESCROW_LOCK",
        amountCents: amount,
        counterpartyAgentId: parsed.data.toAgentId,
        escrowId,
        note: parsed.data.note,
        createdAt: now,
      });
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    await logEvent({
      eventType: "TRANSFER_FAILED",
      orgId: fromAgent.orgId,
      controllerId: fromAgent.controllerId,
      agentId: fromAgentId,
      actorAgentId: fromAgentId,
      targetAgentId: parsed.data.toAgentId,
      amountCents: amount,
      reason: msg,
    });

    if (msg.includes("Insufficient funds")) return res.status(400).json({ error: "Insufficient funds" });
    if (msg.includes("Wallet not found")) return res.status(404).json({ error: "Wallet not found" });
    return res.status(500).json({ error: "Escrow create failed", detail: msg });
  }

  await logEvent({
    eventType: "ESCROW_CREATED",
    orgId: fromAgent.orgId,
    controllerId: fromAgent.controllerId,
    agentId: fromAgentId,
    actorAgentId: fromAgentId,
    targetAgentId: parsed.data.toAgentId,
    escrowId,
    amountCents: amount,
    txId: txLockId,
    metadata: { note: parsed.data.note },
  });

  const fromWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, fromAgentId))
    .then((r) => r[0]);

  return res.status(201).json({
    success: true,
    escrowId,
    status: "LOCKED",
    fromAgentId,
    toAgentId: parsed.data.toAgentId,
    amountCents: amount,
    fromNewBalanceCents: fromWalletAfter?.balanceCents ?? null,
    txLockId,
  });
});

/**
 * Escrow read
 */
app.get("/v1/escrows/:escrowId", async (req, res) => {
  const escrowId = req.params.escrowId;

  const escrow = await db
    .select()
    .from(escrowsTable)
    .where(eq(escrowsTable.id, escrowId))
    .then((r) => r[0]);

  if (!escrow) return res.status(404).json({ error: "Escrow not found" });

  return res.json(escrow);
});

/**
 * Escrow release (SIGNED, payer-only)
 */
app.post("/v1/escrows/:escrowId/release", async (req: any, res) => {
  const escrowId = req.params.escrowId;

  const actorAgentId = req.header("X-Agent-Id") as string | undefined;
  if (!actorAgentId) {
    return res.status(401).json({ error: "Missing X-Agent-Id" });
  }

  const auth = await verifySignedRequestOr401({
    req,
    res,
    agentId: actorAgentId,
    method: "POST",
    path: `/v1/escrows/${escrowId}/release`,
  });
  if (!auth.ok) return;

  const actorAgent = auth.agentRow;

  const escrow = await db
    .select()
    .from(escrowsTable)
    .where(eq(escrowsTable.id, escrowId))
    .then((r) => r[0]);

  if (!escrow) {
    return res.status(404).json({ error: "Escrow not found" });
  }

  if (actorAgentId !== escrow.fromAgentId) {
    await logEvent({
      eventType: "TRANSFER_FAILED",
      orgId: actorAgent.orgId,
      controllerId: actorAgent.controllerId,
      agentId: escrow.fromAgentId,
      actorAgentId,
      targetAgentId: escrow.toAgentId,
      escrowId,
      amountCents: escrow.amountCents,
      reason: "Unauthorized escrow release (only payer can release)",
    });

    return res.status(403).json({
      error: "Only escrow payer (fromAgentId) can release",
      fromAgentId: escrow.fromAgentId,
      actorAgentId,
    });
  }

  if (escrow.status !== "LOCKED") {
    return res.status(400).json({ error: "Escrow is not in LOCKED status" });
  }

  const txReleaseId = randomUUID();
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const toWallet = await tx
        .select()
        .from(walletsTable)
        .where(eq(walletsTable.agentId, escrow.toAgentId))
        .then((r) => r[0]);

      if (!toWallet) throw new Error("Recipient wallet not found");

      await tx
        .update(walletsTable)
        .set({ balanceCents: toWallet.balanceCents + escrow.amountCents })
        .where(eq(walletsTable.agentId, escrow.toAgentId));

      await tx.insert(ledgerTxsTable).values({
        id: txReleaseId,
        agentId: escrow.toAgentId,
        type: "ESCROW_RELEASE",
        amountCents: escrow.amountCents,
        counterpartyAgentId: escrow.fromAgentId,
        escrowId,
        note: escrow.note,
        createdAt: now,
      });

      await tx
        .update(escrowsTable)
        .set({ status: "RELEASED", releasedAt: now })
        .where(eq(escrowsTable.id, escrowId));
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return res.status(500).json({ error: "Escrow release failed", detail: msg });
  }

  const recipientAgent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, escrow.toAgentId))
    .then((r) => r[0]);

  await logEvent({
    eventType: "ESCROW_RELEASED",
    ...(recipientAgent?.orgId != null && { orgId: recipientAgent.orgId }),
    ...(recipientAgent?.controllerId != null && { controllerId: recipientAgent.controllerId }),
    agentId: escrow.toAgentId,
    actorAgentId: escrow.fromAgentId,
    targetAgentId: escrow.toAgentId,
    escrowId,
    amountCents: escrow.amountCents,
    txId: txReleaseId,
  });

  const toWalletAfter = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.agentId, escrow.toAgentId))
    .then((r) => r[0]);

  return res.status(201).json({
    success: true,
    escrowId,
    status: "RELEASED",
    releasedByAgentId: actorAgentId,
    toAgentId: escrow.toAgentId,
    toNewBalanceCents: toWalletAfter?.balanceCents ?? null,
    txReleaseId,
  });
});

/**
 * Audit log (from DB)
 */
app.get("/v1/audit", async (req, res) => {
  const orgId = (req.query.orgId as string | undefined) ?? undefined;
  const agentId = (req.query.agentId as string | undefined) ?? undefined;

  const limitRaw = req.query.limit as string | undefined;
  const limit = Math.min(Math.max(Number(limitRaw ?? "100"), 1), 1000);

  const whereClause =
    orgId && agentId
      ? and(
          eq(auditEventsTable.orgId, orgId),
          or(eq(auditEventsTable.agentId, agentId), eq(auditEventsTable.actorAgentId, agentId))
        )
      : orgId
      ? eq(auditEventsTable.orgId, orgId)
      : agentId
      ? or(eq(auditEventsTable.agentId, agentId), eq(auditEventsTable.actorAgentId, agentId))
      : undefined;

  const events = whereClause
    ? await db
        .select()
        .from(auditEventsTable)
        .where(whereClause)
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(limit)
    : await db.select().from(auditEventsTable).orderBy(desc(auditEventsTable.createdAt)).limit(limit);

  return res.json({ count: events.length, events });
});

app.get("/v1/audit/agents/:agentId", async (req, res) => {
  const agentId = req.params.agentId;
  const limitRaw = req.query.limit as string | undefined;
  const limit = Math.min(Math.max(Number(limitRaw ?? "100"), 1), 1000);

  const events = await db
    .select()
    .from(auditEventsTable)
    .where(or(eq(auditEventsTable.agentId, agentId), eq(auditEventsTable.actorAgentId, agentId)))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(limit);

  return res.json({ agentId, count: events.length, events });
});

/**
 * Dashboard stats — JSON summary for future frontend/dashboard UI
 */
app.get("/v1/dashboard/stats", async (_req, res) => {
  try {
    const [agentsList, walletsList, escrowsList, intentsList, recentAudit] = await Promise.all([
      db.select().from(agents),
      db.select().from(walletsTable),
      db.select().from(escrowsTable),
      db.select().from(paymentIntents),
      db.select().from(auditEventsTable).orderBy(desc(auditEventsTable.createdAt)).limit(100),
    ]);

    const totalAgents = agentsList.length;

    const totalWalletBalanceCents = walletsList.reduce(
      (sum, w) => sum + (w.balanceCents ?? 0),
      0
    );

    const lockedEscrows = escrowsList.filter((e) => e.status === "LOCKED");
    const releasedEscrows = escrowsList.filter((e) => e.status === "RELEASED");

    const totalEscrowNotionalCents = escrowsList.reduce(
      (sum, e) => sum + (e.amountCents ?? 0),
      0
    );

    const openIntents = intentsList.filter((i) => i.status === "CREATED");
    const capturedIntents = intentsList.filter((i) => i.status === "CAPTURED");
    const cancelledIntents = intentsList.filter((i) => i.status === "CANCELLED");
    const expiredIntents = intentsList.filter((i) => i.status === "EXPIRED");

    const recentTransferVolumeCents = recentAudit
      .filter(
        (e) =>
          e.eventType === "TRANSFER_SUCCEEDED" ||
          e.eventType === "INTENT_CAPTURED" ||
          e.eventType === "ESCROW_RELEASED"
      )
      .reduce((sum, e) => sum + (e.amountCents ?? 0), 0);

    return res.json({
      totalAgents,
      totalWalletBalanceCents,
      lockedEscrowsCount: lockedEscrows.length,
      releasedEscrowsCount: releasedEscrows.length,
      totalEscrowNotionalCents,
      openIntentsCount: openIntents.length,
      capturedIntentsCount: capturedIntents.length,
      cancelledIntentsCount: cancelledIntents.length,
      expiredIntentsCount: expiredIntents.length,
      recentAuditEventCount: recentAudit.length,
      recentTransferVolumeCents,
    });
  } catch (err: any) {
    console.error("Dashboard stats error:", err?.message ?? err);
    return res.status(500).json({
      error: "Failed to load dashboard stats",
      message: err?.message ?? String(err),
    });
  }
});

/**
 * Dashboard feeds — JSON data lists for future frontend/dashboard UI
 */
app.get("/v1/dashboard/feeds", async (req, res) => {
  try {
    const agentsLimit = Math.min(Number(req.query.agentsLimit) || 25, 100);
    const escrowsLimit = Math.min(Number(req.query.escrowsLimit) || 25, 100);
    const intentsLimit = Math.min(Number(req.query.intentsLimit) || 25, 100);
    const auditLimit = Math.min(Number(req.query.auditLimit) || 50, 200);

    const [agentsList, escrowsList, intentsList, auditList] = await Promise.all([
      db
        .select({
          id: agents.id,
          orgId: agents.orgId,
          controllerId: agents.controllerId,
          createdAt: agents.createdAt,
          balanceCents: walletsTable.balanceCents,
        })
        .from(agents)
        .leftJoin(walletsTable, eq(agents.id, walletsTable.agentId))
        .orderBy(desc(agents.createdAt))
        .limit(agentsLimit),

      db
        .select()
        .from(escrowsTable)
        .orderBy(desc(escrowsTable.createdAt))
        .limit(escrowsLimit),

      db
        .select()
        .from(paymentIntents)
        .orderBy(desc(paymentIntents.createdAt))
        .limit(intentsLimit),

      db
        .select()
        .from(auditEventsTable)
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(auditLimit),
    ]);

    return res.json({
      agents: agentsList,
      escrows: escrowsList,
      intents: intentsList,
      auditEvents: auditList,
    });
  } catch (err: any) {
    console.error("Dashboard feeds error:", err?.message ?? err);
    return res.status(500).json({
      error: "Failed to load dashboard feeds",
      message: err?.message ?? String(err),
    });
  }
});

/**
 * Dashboard — agents, wallets, escrows, intents, recent audit
 */
app.get("/dashboard", async (_req, res, next) => {
  try {
    const [agentsList, escrowsList, intentsList, events] = await Promise.all([
      db
        .select({
          id: agents.id,
          orgId: agents.orgId,
          controllerId: agents.controllerId,
          createdAt: agents.createdAt,
          balanceCents: walletsTable.balanceCents,
        })
        .from(agents)
        .leftJoin(walletsTable, eq(agents.id, walletsTable.agentId))
        .orderBy(desc(agents.createdAt))
        .limit(100),
      db
        .select()
        .from(escrowsTable)
        .orderBy(desc(escrowsTable.createdAt))
        .limit(50),
      db
        .select()
        .from(paymentIntents)
        .orderBy(desc(paymentIntents.createdAt))
        .limit(50),
      db
        .select()
        .from(auditEventsTable)
        .orderBy(desc(auditEventsTable.createdAt))
        .limit(100),
    ]);

    const totalAgents = agentsList.length;
    const totalBalanceCents = agentsList.reduce((sum, a) => sum + (a.balanceCents ?? 0), 0);
    const lockedEscrows = escrowsList.filter((e) => e.status === "LOCKED");
    const totalEscrowCents = escrowsList.reduce((sum, e) => sum + e.amountCents, 0);
    const openIntents = intentsList.filter((i) => i.status === "CREATED");
    const capturedIntents = intentsList.filter((i) => i.status === "CAPTURED");
    const cancelledIntents = intentsList.filter((i) => i.status === "CANCELLED");
    const expiredIntents = intentsList.filter((i) => i.status === "EXPIRED");

    const formatDollars = (cents: number | null | undefined) =>
      `$${(((cents ?? 0) as number) / 100).toFixed(2)}`;

    const agentRows = agentsList
      .map(
        (a) => `
    <tr>
      <td><code>${a.id}</code></td>
      <td>${a.orgId}</td>
      <td>${formatDollars(a.balanceCents ?? 0)}</td>
      <td>${a.createdAt}</td>
    </tr>`
      )
      .join("");

    const escrowRows = escrowsList
      .map(
        (e) => `
    <tr>
      <td><code>${e.id}</code></td>
      <td><code>${e.fromAgentId}</code></td>
      <td><code>${e.toAgentId}</code></td>
      <td>${formatDollars(e.amountCents)}</td>
      <td>${e.status}</td>
      <td>${e.createdAt}</td>
    </tr>`
      )
      .join("");

    const intentRows = intentsList
      .map(
        (i) => `
    <tr>
      <td><code>${i.id}</code></td>
      <td><code>${i.fromAgentId}</code></td>
      <td><code>${i.toAgentId}</code></td>
      <td>${formatDollars(i.amountCents)}</td>
      <td>${i.status}</td>
      <td>${i.createdAt}</td>
    </tr>`
      )
      .join("");

    const eventRows = events
      .map(
        (e) => `
    <tr>
      <td>${e.createdAt}</td>
      <td>${e.eventType}</td>
      <td>${e.agentId ?? ""}</td>
      <td>${e.actorAgentId ?? ""}</td>
      <td>${e.targetAgentId ?? ""}</td>
      <td>${e.amountCents != null ? formatDollars(e.amountCents) : ""}</td>
      <td>${(e.reason ?? "").slice(0, 60)}</td>
    </tr>`
      )
      .join("");

    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Proxify Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #0f0f12; color: #e4e4e7; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    h2 { font-size: 1.1rem; margin: 24px 0 12px; color: #a1a1aa; }
    a { color: #818cf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #27272a; padding: 10px 12px; text-align: left; }
    th { background: #18181b; color: #a1a1aa; font-weight: 600; }
    tr:hover { background: #18181b; }
    code { font-size: 11px; background: #27272a; padding: 2px 6px; border-radius: 4px; }
    .nav { margin-bottom: 24px; }
    .layout { max-width: 1120px; margin: 0 auto; }
    .subtitle { color: #a1a1aa; margin-bottom: 16px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0 28px; }
    .card { background: #18181b; border-radius: 10px; padding: 12px 14px; border: 1px solid #27272a; }
    .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #71717a; margin-bottom: 4px; }
    .card-value { font-size: 18px; font-weight: 600; }
    .card-detail { font-size: 11px; color: #a1a1aa; margin-top: 2px; }
    .section { margin-bottom: 32px; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="nav"><a href="/dashboard">Dashboard</a> | <a href="/audit-view">Audit log</a></div>
    <h1>Proxify Dashboard</h1>
    <p class="subtitle">Financial infrastructure for autonomous agents — agents, wallets, intents, escrows, and audit trail.</p>

    <div class="cards">
      <div class="card">
        <div class="card-label">Agents</div>
        <div class="card-value">${totalAgents}</div>
        <div class="card-detail">Registered autonomous agents</div>
      </div>
      <div class="card">
        <div class="card-label">Aggregate balance</div>
        <div class="card-value">${formatDollars(totalBalanceCents)}</div>
        <div class="card-detail">Sum across all wallets</div>
      </div>
      <div class="card">
        <div class="card-label">Open escrows</div>
        <div class="card-value">${lockedEscrows.length}</div>
        <div class="card-detail">Funds currently locked</div>
      </div>
      <div class="card">
        <div class="card-label">Escrow notional</div>
        <div class="card-value">${formatDollars(totalEscrowCents)}</div>
        <div class="card-detail">Total escrow value (all statuses)</div>
      </div>
      <div class="card">
        <div class="card-label">Open intents</div>
        <div class="card-value">${openIntents.length}</div>
        <div class="card-detail">Created but not captured</div>
      </div>
      <div class="card">
        <div class="card-label">Captured intents</div>
        <div class="card-value">${capturedIntents.length}</div>
        <div class="card-detail">Settled via intent flow</div>
      </div>
      <div class="card">
        <div class="card-label">Cancelled intents</div>
        <div class="card-value">${cancelledIntents.length}</div>
        <div class="card-detail">Cancelled before settlement</div>
      </div>
      <div class="card">
        <div class="card-label">Expired intents</div>
        <div class="card-value">${expiredIntents.length}</div>
        <div class="card-detail">Expired before capture</div>
      </div>
    </div>

    <div class="section">
      <h2>Agents & balances</h2>
      <table>
        <thead><tr><th>Agent ID</th><th>Org ID</th><th>Balance</th><th>Created</th></tr></thead>
        <tbody>${agentRows || "<tr><td colspan='4'>No agents yet — run the demo.</td></tr>"}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>Open / recent escrows</h2>
      <table>
        <thead><tr><th>Escrow ID</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${escrowRows || "<tr><td colspan='6'>No escrows yet.</td></tr>"}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>Payment intents</h2>
      <table>
        <thead><tr><th>Intent ID</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${intentRows || "<tr><td colspan='6'>No payment intents yet.</td></tr>"}</tbody>
      </table>
    </div>

    <div class="section">
      <h2>Recent audit events</h2>
      <table>
        <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Actor</th><th>Target</th><th>Amount</th><th>Reason</th></tr></thead>
        <tbody>${eventRows || "<tr><td colspan='7'>No events yet.</td></tr>"}</tbody>
      </table>
    </div>
  </div>
</body>
</html>
    `);
  } catch (e) {
    next(e);
  }
});

/**
 * Audit view — full audit log with optional agent filter
 */
app.get("/audit-view", async (req, res, next) => {
  try {
    const agentId = (req.query.agentId as string) ?? undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 500);

    const whereClause = agentId
      ? or(eq(auditEventsTable.agentId, agentId), eq(auditEventsTable.actorAgentId, agentId))
      : undefined;

    const events = whereClause
      ? await db
          .select()
          .from(auditEventsTable)
          .where(whereClause)
          .orderBy(desc(auditEventsTable.createdAt))
          .limit(limit)
      : await db
          .select()
          .from(auditEventsTable)
          .orderBy(desc(auditEventsTable.createdAt))
          .limit(limit);

    const formatDollars = (cents: number | null | undefined) =>
      cents == null ? "" : `$${(cents / 100).toFixed(2)}`;

    const rows = events
      .map(
        (e) => `
      <tr>
        <td>${e.createdAt}</td>
        <td>${e.eventType}</td>
        <td>${e.orgId ?? ""}</td>
        <td>${e.agentId ?? ""}</td>
        <td>${e.actorAgentId ?? ""}</td>
        <td>${e.targetAgentId ?? ""}</td>
        <td>${formatDollars(e.amountCents)}</td>
        <td>${e.reason ?? ""}</td>
      </tr>
    `
      )
      .join("");

    const filterNote = agentId ? ` (filter: agent ${agentId})` : "";

    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Audit Log</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 20px; background: #0f0f12; color: #e4e4e7; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #27272a; padding: 8px; }
    th { background: #18181b; color: #a1a1aa; }
    a { color: #818cf8; }
    .layout { max-width: 1080px; margin: 0 auto; }
    .subtitle { color: #a1a1aa; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="layout">
    <p><a href="/dashboard">Dashboard</a> | <a href="/audit-view">Audit log</a></p>
    <h2>Audit log (latest ${limit})${filterNote}</h2>
    <p class="subtitle">Every funding, transfer, payment intent, policy change, and escrow event leaves a trail here.</p>
    <form method="get" style="margin-bottom:16px">
      <label>Filter by agent ID&nbsp;
        <input type="text" name="agentId" value="${agentId ?? ""}" placeholder="Agent UUID from dashboard" />
      </label>
      <button type="submit">Apply</button>
    </form>
    <table>
      <thead>
        <tr>
          <th>createdAt</th>
          <th>eventType</th>
          <th>orgId</th>
          <th>agentId</th>
          <th>actorAgentId</th>
          <th>targetAgentId</th>
          <th>amount</th>
          <th>reason</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>
    `);
  } catch (e) {
    next(e);
  }
});

/**
 * Global error handler — ensure API always returns JSON on error
 */
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).json({
      error: "Internal server error",
      message: err?.message ?? String(err),
    });
  }
});

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});