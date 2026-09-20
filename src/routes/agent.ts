import { and, desc, eq, lt, or } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { auditEvents, escrows, ledgerTxs, paymentIntents, policies, wallets } from "../db/schema";
import { HEADERS } from "../lib/canonical";
import { AppError, badRequest, notFound } from "../lib/errors";
import { clampLimit, parse, zCents, zNote, zUuid } from "../lib/http";
import { hasAdminCredentials, requireSelfOrAdmin, requireSignature } from "../middleware/auth";
import { recordFailure, type AuditInput } from "../services/audit";
import { withIdempotency, type HandlerResult } from "../services/idempotency";
import * as pay from "../services/payments";

/** Runs `fn`; if it fails on a business rule (policy, funds, ownership, state), records that in the audit log, then rethrows. */
async function audited<T>(db: Db, base: Omit<AuditInput, "eventType">, failType: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && e.auditable) {
      await recordFailure(db, { ...base, eventType: failType, reason: e.message, metadata: { code: e.code, ...e.details, ...base.metadata } });
    }
    throw e;
  }
}

function idempotencyKey(req: Request, required: boolean): string | undefined {
  const key = req.header(HEADERS.idempotencyKey);
  if (!key) {
    if (required) throw badRequest("Missing Idempotency-Key header", "IDEMPOTENCY_KEY_REQUIRED");
    return undefined;
  }
  if (key.length > 200) throw badRequest("Idempotency-Key too long (max 200)", "VALIDATION_ERROR");
  return key;
}

/** Everything an authenticated agent does: signed writes and self-scoped reads. */
export function agentRoutes(db: Db, config: Config): Router {
  const r = Router();
  const signed = requireSignature(db, config);
  const selfOrAdmin = requireSelfOrAdmin(db, config);

  // ------------------------------------------------------------ reads (self or admin)
  r.get("/agents/:agentId/wallet", selfOrAdmin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const [w] = await db.select().from(wallets).where(eq(wallets.agentId, agentId));
    if (!w) throw notFound("Agent not found", "AGENT_NOT_FOUND");
    const recent = await db
      .select()
      .from(ledgerTxs)
      .where(eq(ledgerTxs.agentId, agentId))
      .orderBy(desc(ledgerTxs.createdAt))
      .limit(20);
    res.json({ agentId, balanceCents: w.balanceCents, recentTransactions: recent });
  });

  r.get("/agents/:agentId/ledger", selfOrAdmin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const limit = clampLimit(req.query.limit, 50, 200);
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) throw badRequest("before must be an ISO timestamp", "VALIDATION_ERROR");
    const rows = await db
      .select()
      .from(ledgerTxs)
      .where(and(eq(ledgerTxs.agentId, agentId), before ? lt(ledgerTxs.createdAt, before) : undefined))
      .orderBy(desc(ledgerTxs.createdAt))
      .limit(limit);
    res.json({ agentId, count: rows.length, transactions: rows, nextBefore: rows.length === limit ? rows[rows.length - 1]!.createdAt : null });
  });

  r.get("/agents/:agentId/policy", selfOrAdmin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const [p] = await db.select().from(policies).where(eq(policies.agentId, agentId));
    if (!p) throw notFound("Policy not found", "POLICY_NOT_FOUND");
    res.json(p);
  });

  const auditForAgent = async (agentId: string, req: Request) => {
    const limit = clampLimit(req.query.limit, 100, 1000);
    const cursor = Number(req.query.cursor);
    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          or(eq(auditEvents.agentId, agentId), eq(auditEvents.actorAgentId, agentId)),
          Number.isFinite(cursor) && req.query.cursor !== undefined ? lt(auditEvents.seq, cursor) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
    return { agentId, count: events.length, events, nextCursor: events.length === limit ? events[events.length - 1]!.seq : null };
  };
  r.get("/audit/agents/:agentId", selfOrAdmin, async (req, res) => {
    res.json(await auditForAgent(parse(zUuid, req.params.agentId), req));
  });

  // ------------------------------------------------------------ transfers
  r.post("/tx/transfer", signed, async (req, res) => {
    const key = idempotencyKey(req, true)!;
    const body = parse(z.object({ toAgentId: zUuid, amountCents: zCents, note: zNote.optional() }), req.body);
    const from = req.agent!;
    const out = await audited(
      db,
      { orgId: from.orgId, controllerId: from.controllerId, agentId: from.id, actorAgentId: from.id, targetAgentId: body.toAgentId, amountCents: body.amountCents },
      "TRANSFER_FAILED",
      () =>
        withIdempotency(db, from.id, key, "/v1/tx/transfer", req.rawBody ?? "", async (tx): Promise<HandlerResult> => ({
          status: 201,
          body: await pay.executeTransfer(tx, { from, toAgentId: body.toAgentId, amountCents: body.amountCents, note: body.note }),
        })),
    );
    res.status(out.status).set("Idempotent-Replayed", String(out.replayed)).json(out.body);
  });

  // ------------------------------------------------------------ escrows
  r.post("/escrows", signed, async (req, res) => {
    const key = idempotencyKey(req, false);
    const body = parse(z.object({ toAgentId: zUuid, amountCents: zCents, note: zNote.optional() }), req.body);
    const from = req.agent!;
    const create = async (tx: Db): Promise<HandlerResult> => ({
      status: 201,
      body: await pay.createEscrow(tx, { from, toAgentId: body.toAgentId, amountCents: body.amountCents, note: body.note }),
    });
    const out = await audited(
      db,
      { orgId: from.orgId, controllerId: from.controllerId, agentId: from.id, actorAgentId: from.id, targetAgentId: body.toAgentId, amountCents: body.amountCents },
      "ESCROW_CREATE_FAILED",
      async () =>
        key
          ? withIdempotency(db, from.id, key, "/v1/escrows", req.rawBody ?? "", create)
          : { ...(await db.transaction(create)), replayed: false },
    );
    res.status(out.status).set("Idempotent-Replayed", String(out.replayed)).json(out.body);
  });

  r.get("/escrows/:escrowId", async (req, res, next) => {
    // payer, worker, or admin
    const escrowId = parse(zUuid, req.params.escrowId);
    const admin = hasAdminCredentials(req, config);
    if (!admin) await signed(req, res, () => {});
    const [escrow] = await db.select().from(escrows).where(eq(escrows.id, escrowId));
    const me = req.agent?.id;
    if (!escrow || (!admin && escrow.fromAgentId !== me && escrow.toAgentId !== me)) {
      throw notFound("Escrow not found", "ESCROW_NOT_FOUND"); // same answer for "missing" and "not yours"
    }
    res.json(escrow);
    void next;
  });

  const settle = (mode: "release" | "refund") => async (req: Request, res: import("express").Response) => {
    const escrowId = parse(zUuid, req.params.escrowId);
    const caller = req.agent!;
    const out = await audited(
      db,
      { orgId: caller.orgId, controllerId: caller.controllerId, agentId: caller.id, actorAgentId: caller.id, escrowId },
      mode === "release" ? "ESCROW_RELEASE_FAILED" : "ESCROW_REFUND_FAILED",
      async () => db.transaction(async (tx) => (mode === "release" ? await pay.releaseEscrow(tx, escrowId, caller) : await pay.refundEscrow(tx, escrowId, caller))),
    );
    res.status(201).json(out);
  };
  r.post("/escrows/:escrowId/release", signed, settle("release"));
  r.post("/escrows/:escrowId/refund", signed, settle("refund"));

  // ------------------------------------------------------------ payment intents
  r.post("/intents", signed, async (req, res) => {
    const key = idempotencyKey(req, false);
    const body = parse(
      z.object({ toAgentId: zUuid, amountCents: zCents, note: zNote.optional(), expiresAt: z.string().datetime().optional() }),
      req.body,
    );
    const from = req.agent!;
    const create = async (tx: Db): Promise<HandlerResult> => ({
      status: 201,
      body: await pay.createIntent(tx, {
        from,
        toAgentId: body.toAgentId,
        amountCents: body.amountCents,
        note: body.note,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      }),
    });
    const out = await audited(
      db,
      { orgId: from.orgId, controllerId: from.controllerId, agentId: from.id, actorAgentId: from.id, targetAgentId: body.toAgentId, amountCents: body.amountCents },
      "INTENT_FAILED",
      async () =>
        key
          ? withIdempotency(db, from.id, key, "/v1/intents", req.rawBody ?? "", create)
          : { ...(await db.transaction(create)), replayed: false },
    );
    res.status(out.status).set("Idempotent-Replayed", String(out.replayed)).json(out.body);
  });

  r.get("/intents/:intentId", async (req, res) => {
    const intentId = parse(zUuid, req.params.intentId);
    const admin = hasAdminCredentials(req, config);
    if (!admin) await signed(req, res, () => {});
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId));
    const me = req.agent?.id;
    if (!intent || (!admin && intent.fromAgentId !== me && intent.toAgentId !== me)) {
      throw notFound("Intent not found", "INTENT_NOT_FOUND");
    }
    res.json(intent);
  });

  r.post("/intents/:intentId/capture", signed, async (req, res) => {
    const intentId = parse(zUuid, req.params.intentId);
    const caller = req.agent!;
    const out = await audited(
      db,
      { orgId: caller.orgId, controllerId: caller.controllerId, agentId: caller.id, actorAgentId: caller.id, metadata: { intentId } },
      "INTENT_CAPTURE_FAILED",
      () => db.transaction((tx) => pay.captureIntent(tx, intentId, caller)),
    );
    if (out.expired) throw new AppError(409, "INTENT_EXPIRED", "Intent has expired", { status: "EXPIRED" });
    res.status(201).json(out.body);
  });

  r.post("/intents/:intentId/cancel", signed, async (req, res) => {
    const intentId = parse(zUuid, req.params.intentId);
    const out = await db.transaction((tx) => pay.cancelIntent(tx, intentId, req.agent!));
    res.json(out);
  });

  return r;
}
