import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, escrows, paymentIntents } from "../db/schema";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { writeAudit } from "./audit";
import {
  addLedger,
  adjustBalance,
  assertCreditable,
  assertSufficient,
  enforcePolicy,
  lockWallets,
  requireActiveAgent,
} from "./wallets";

export interface Actor {
  id: string;
  orgId: string;
  controllerId: string;
}

// ---------------------------------------------------------------- transfers

export interface TransferInput {
  from: Actor;
  toAgentId: string;
  amountCents: number;
  note?: string | undefined;
  /** Audit event type; intent capture reuses this path with its own type. */
  auditType?: string;
  auditMetadata?: Record<string, unknown>;
}

export async function executeTransfer(tx: Db, i: TransferInput) {
  if (i.from.id === i.toAgentId) throw badRequest("Cannot transfer to yourself", "SELF_TRANSFER");
  const to = await requireActiveAgent(tx, i.toAgentId, "Recipient");

  const balances = await lockWallets(tx, [i.from.id, i.toAgentId]);
  await enforcePolicy(tx, i.from.id, i.amountCents);
  assertSufficient(balances.get(i.from.id)!, i.amountCents);
  assertCreditable(balances.get(i.toAgentId)!, i.amountCents);

  const fromNew = await adjustBalance(tx, i.from.id, -i.amountCents);
  const toNew = await adjustBalance(tx, i.toAgentId, i.amountCents);
  const txOutId = await addLedger(tx, {
    agentId: i.from.id,
    type: "TRANSFER_OUT",
    amountCents: i.amountCents,
    counterpartyAgentId: i.toAgentId,
    note: i.note,
  });
  const txInId = await addLedger(tx, {
    agentId: i.toAgentId,
    type: "TRANSFER_IN",
    amountCents: i.amountCents,
    counterpartyAgentId: i.from.id,
    note: i.note,
  });
  await writeAudit(tx, {
    eventType: i.auditType ?? "TRANSFER_SUCCEEDED",
    orgId: i.from.orgId,
    controllerId: i.from.controllerId,
    agentId: i.from.id,
    actorAgentId: i.from.id,
    targetAgentId: i.toAgentId,
    amountCents: i.amountCents,
    txId: txOutId,
    metadata: { txOutId, txInId, note: i.note, ...i.auditMetadata },
    notifyOrgIds: [to.orgId],
  });
  return {
    success: true as const,
    fromAgentId: i.from.id,
    toAgentId: i.toAgentId,
    amountCents: i.amountCents,
    fromNewBalanceCents: fromNew,
    toNewBalanceCents: toNew,
    txOutId,
    txInId,
  };
}

// ---------------------------------------------------------------- escrow

export async function createEscrow(
  tx: Db,
  i: { from: Actor; toAgentId: string; amountCents: number; note?: string | undefined },
) {
  if (i.from.id === i.toAgentId) throw badRequest("Payer and recipient must differ", "SELF_ESCROW");
  const to = await requireActiveAgent(tx, i.toAgentId, "Recipient");

  const balances = await lockWallets(tx, [i.from.id]);
  await enforcePolicy(tx, i.from.id, i.amountCents);
  assertSufficient(balances.get(i.from.id)!, i.amountCents);

  // Funds leave the payer now; from here they exist only inside the escrow row.
  const fromNew = await adjustBalance(tx, i.from.id, -i.amountCents);
  const [escrow] = await tx
    .insert(escrows)
    .values({ fromAgentId: i.from.id, toAgentId: i.toAgentId, amountCents: i.amountCents, note: i.note ?? null, status: "LOCKED" })
    .returning();
  const txLockId = await addLedger(tx, {
    agentId: i.from.id,
    type: "ESCROW_LOCK",
    amountCents: i.amountCents,
    counterpartyAgentId: i.toAgentId,
    escrowId: escrow!.id,
    note: i.note,
  });
  await writeAudit(tx, {
    eventType: "ESCROW_CREATED",
    orgId: i.from.orgId,
    controllerId: i.from.controllerId,
    agentId: i.from.id,
    actorAgentId: i.from.id,
    targetAgentId: i.toAgentId,
    escrowId: escrow!.id,
    amountCents: i.amountCents,
    txId: txLockId,
    metadata: { note: i.note },
    notifyOrgIds: [to.orgId],
  });
  return {
    success: true as const,
    escrowId: escrow!.id,
    status: "LOCKED",
    fromAgentId: i.from.id,
    toAgentId: i.toAgentId,
    amountCents: i.amountCents,
    fromNewBalanceCents: fromNew,
    txLockId,
  };
}

/**
 * Settles a LOCKED escrow one of two ways. Each side holds exactly one exit:
 * the payer can RELEASE to the worker, the worker can REFUND to the payer.
 * Neither side can take funds from the other unilaterally.
 */
async function settleEscrow(tx: Db, escrowId: string, caller: Actor, mode: "release" | "refund") {
  // Row lock: two concurrent settlements serialise; the loser sees a non-LOCKED status.
  const [escrow] = await tx.select().from(escrows).where(eq(escrows.id, escrowId)).for("update");
  if (!escrow) throw notFound("Escrow not found", "ESCROW_NOT_FOUND");

  const allowedCaller = mode === "release" ? escrow.fromAgentId : escrow.toAgentId;
  if (caller.id !== allowedCaller) {
    throw forbidden(
      mode === "release" ? "Only the escrow payer can release" : "Only the escrow recipient can refund",
      mode === "release" ? "NOT_PAYER" : "NOT_RECIPIENT",
    );
  }
  if (escrow.status !== "LOCKED") {
    throw conflict(`Escrow is ${escrow.status}, not LOCKED`, "ESCROW_NOT_LOCKED", { status: escrow.status });
  }

  const beneficiary = mode === "release" ? escrow.toAgentId : escrow.fromAgentId;
  const balances = await lockWallets(tx, [beneficiary]);
  assertCreditable(balances.get(beneficiary)!, escrow.amountCents);
  const newBalance = await adjustBalance(tx, beneficiary, escrow.amountCents);

  const now = new Date();
  const ledgerId = await addLedger(tx, {
    agentId: beneficiary,
    type: mode === "release" ? "ESCROW_RELEASE" : "ESCROW_REFUND",
    amountCents: escrow.amountCents,
    counterpartyAgentId: mode === "release" ? escrow.fromAgentId : escrow.toAgentId,
    escrowId,
    note: escrow.note,
  });
  await tx
    .update(escrows)
    .set({ status: mode === "release" ? "RELEASED" : "REFUNDED", releasedAt: now })
    .where(and(eq(escrows.id, escrowId), eq(escrows.status, "LOCKED")));

  const other = await requireAgentOrg(tx, beneficiary);
  await writeAudit(tx, {
    eventType: mode === "release" ? "ESCROW_RELEASED" : "ESCROW_REFUNDED",
    orgId: caller.orgId,
    controllerId: caller.controllerId,
    agentId: escrow.fromAgentId,
    actorAgentId: caller.id,
    targetAgentId: beneficiary,
    escrowId,
    amountCents: escrow.amountCents,
    txId: ledgerId,
    notifyOrgIds: [other],
  });
  return { escrow, ledgerId, newBalance, beneficiary };
}

export async function releaseEscrow(tx: Db, escrowId: string, caller: Actor) {
  const r = await settleEscrow(tx, escrowId, caller, "release");
  return {
    success: true as const,
    escrowId,
    status: "RELEASED",
    releasedByAgentId: caller.id,
    toAgentId: r.beneficiary,
    toNewBalanceCents: r.newBalance,
    txReleaseId: r.ledgerId,
  };
}

export async function refundEscrow(tx: Db, escrowId: string, caller: Actor) {
  const r = await settleEscrow(tx, escrowId, caller, "refund");
  return {
    success: true as const,
    escrowId,
    status: "REFUNDED",
    refundedByAgentId: caller.id,
    toAgentId: r.beneficiary,
    toNewBalanceCents: r.newBalance,
    txRefundId: r.ledgerId,
  };
}

/** A suspended agent may still be the beneficiary of an already-locked escrow; only existence matters. */
async function requireAgentOrg(tx: Db, agentId: string): Promise<string> {
  const [a] = await tx.select({ orgId: agents.orgId }).from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound("Agent not found", "AGENT_NOT_FOUND");
  return a.orgId;
}

// ---------------------------------------------------------------- payment intents

export async function createIntent(
  tx: Db,
  i: { from: Actor; toAgentId: string; amountCents: number; note?: string | undefined; expiresAt?: Date | undefined },
) {
  if (i.from.id === i.toAgentId) throw badRequest("Payer and recipient must differ", "SELF_INTENT");
  if (i.expiresAt && i.expiresAt.getTime() <= Date.now()) throw badRequest("expiresAt must be in the future", "VALIDATION_ERROR");
  const to = await requireActiveAgent(tx, i.toAgentId, "Recipient");
  await enforcePolicy(tx, i.from.id, i.amountCents, { daily: false }); // funds/daily cap are checked at capture time

  const [intent] = await tx
    .insert(paymentIntents)
    .values({
      fromAgentId: i.from.id,
      toAgentId: i.toAgentId,
      amountCents: i.amountCents,
      note: i.note ?? null,
      status: "CREATED",
      expiresAt: i.expiresAt ?? null,
    })
    .returning();
  await writeAudit(tx, {
    eventType: "INTENT_CREATED",
    orgId: i.from.orgId,
    controllerId: i.from.controllerId,
    agentId: i.from.id,
    actorAgentId: i.from.id,
    targetAgentId: i.toAgentId,
    amountCents: i.amountCents,
    metadata: { intentId: intent!.id, note: i.note ?? null, expiresAt: i.expiresAt ?? null },
    notifyOrgIds: [to.orgId],
  });
  return { success: true as const, intent: intent! };
}

/** Returns `expired: true` (and persists EXPIRED) instead of throwing, so the state change commits. */
export async function captureIntent(tx: Db, intentId: string, caller: Actor) {
  const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).for("update");
  if (!intent) throw notFound("Intent not found", "INTENT_NOT_FOUND");
  if (intent.fromAgentId !== caller.id) throw forbidden("Only the payer can capture this intent", "NOT_PAYER");
  if (intent.status !== "CREATED") {
    throw conflict(`Intent is ${intent.status}, not capturable`, "INTENT_NOT_CAPTURABLE", { status: intent.status });
  }
  if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) {
    await tx.update(paymentIntents).set({ status: "EXPIRED" }).where(eq(paymentIntents.id, intentId));
    await writeAudit(tx, {
      eventType: "INTENT_EXPIRED",
      orgId: caller.orgId,
      agentId: caller.id,
      actorAgentId: caller.id,
      targetAgentId: intent.toAgentId,
      amountCents: intent.amountCents,
      metadata: { intentId },
    });
    return { expired: true as const };
  }

  const transfer = await executeTransfer(tx, {
    from: caller,
    toAgentId: intent.toAgentId,
    amountCents: intent.amountCents,
    note: `Intent capture ${intentId}${intent.note ? ` - ${intent.note}` : ""}`,
    auditType: "INTENT_CAPTURED",
    auditMetadata: { intentId },
  });
  await tx.update(paymentIntents).set({ status: "CAPTURED", capturedAt: new Date() }).where(eq(paymentIntents.id, intentId));
  return {
    expired: false as const,
    body: {
      success: true as const,
      intentId,
      status: "CAPTURED",
      fromAgentId: transfer.fromAgentId,
      toAgentId: transfer.toAgentId,
      amountCents: transfer.amountCents,
      fromNewBalanceCents: transfer.fromNewBalanceCents,
      toNewBalanceCents: transfer.toNewBalanceCents,
      txOutId: transfer.txOutId,
      txInId: transfer.txInId,
    },
  };
}

export async function cancelIntent(tx: Db, intentId: string, caller: Actor) {
  const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).for("update");
  if (!intent) throw notFound("Intent not found", "INTENT_NOT_FOUND");
  if (intent.fromAgentId !== caller.id) throw forbidden("Only the payer can cancel this intent", "NOT_PAYER");
  if (intent.status !== "CREATED") {
    throw conflict(`Intent is ${intent.status}, not cancellable`, "INTENT_NOT_CANCELLABLE", { status: intent.status });
  }
  await tx.update(paymentIntents).set({ status: "CANCELLED" }).where(eq(paymentIntents.id, intentId));
  await writeAudit(tx, {
    eventType: "INTENT_CANCELLED",
    orgId: caller.orgId,
    controllerId: caller.controllerId,
    agentId: caller.id,
    actorAgentId: caller.id,
    targetAgentId: intent.toAgentId,
    amountCents: intent.amountCents,
    metadata: { intentId },
  });
  return { success: true as const, intentId, status: "CANCELLED" };
}
