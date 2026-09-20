import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, controllers, orgs, policies, wallets } from "../db/schema";
import { AppError, badRequest, notFound } from "../lib/errors";
import { MAX_CENTS } from "../lib/http";
import { writeAudit } from "./audit";
import { addLedger, lockWallets } from "./wallets";

export const DEFAULT_MAX_TX_CENTS = 5000;

/** Accepts only a well-formed Ed25519 SPKI public key; anything else can never verify a signature. */
export function assertEd25519Pem(pem: string): void {
  try {
    if (createPublicKey(pem).asymmetricKeyType === "ed25519") return;
  } catch {
    /* fall through */
  }
  throw badRequest("publicKeyPem must be an Ed25519 public key in PEM (SPKI) format", "INVALID_PUBLIC_KEY");
}

export async function createOrg(tx: Db, name: string) {
  const [org] = await tx.insert(orgs).values({ name }).returning();
  await writeAudit(tx, { eventType: "ORG_CREATED", orgId: org!.id, metadata: { name } });
  return org!;
}

export async function createController(tx: Db, orgId: string, displayName: string) {
  const [org] = await tx.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw notFound("Org not found", "ORG_NOT_FOUND");
  const [c] = await tx.insert(controllers).values({ orgId, displayName }).returning();
  await writeAudit(tx, { eventType: "CONTROLLER_CREATED", orgId, controllerId: c!.id, metadata: { displayName } });
  return c!;
}

export async function registerAgent(
  tx: Db,
  i: { orgId: string; controllerId: string; publicKeyPem: string; maxTxCents: number; dailyLimitCents?: number | undefined },
) {
  assertEd25519Pem(i.publicKeyPem);
  const [controller] = await tx.select().from(controllers).where(eq(controllers.id, i.controllerId));
  if (!controller) throw notFound("Controller not found", "CONTROLLER_NOT_FOUND");
  if (controller.orgId !== i.orgId) throw badRequest("Controller does not belong to org", "CONTROLLER_ORG_MISMATCH");

  const [agent] = await tx
    .insert(agents)
    .values({ orgId: i.orgId, controllerId: i.controllerId, publicKeyPem: i.publicKeyPem })
    .returning();
  await tx.insert(wallets).values({ agentId: agent!.id, balanceCents: 0 });
  await tx.insert(policies).values({ agentId: agent!.id, maxTxCents: i.maxTxCents, dailyLimitCents: i.dailyLimitCents ?? null });
  await writeAudit(tx, {
    eventType: "AGENT_REGISTERED",
    orgId: i.orgId,
    controllerId: i.controllerId,
    agentId: agent!.id,
    metadata: { maxTxCents: i.maxTxCents, dailyLimitCents: i.dailyLimitCents ?? null },
  });
  return agent!;
}

export async function setAgentStatus(tx: Db, agentId: string, status: "ACTIVE" | "SUSPENDED") {
  const [agent] = await tx.update(agents).set({ status }).where(eq(agents.id, agentId)).returning();
  if (!agent) throw notFound("Agent not found", "AGENT_NOT_FOUND");
  await writeAudit(tx, {
    eventType: status === "SUSPENDED" ? "AGENT_SUSPENDED" : "AGENT_REACTIVATED",
    orgId: agent.orgId,
    controllerId: agent.controllerId,
    agentId,
  });
  return agent;
}

export async function setPolicy(
  tx: Db,
  agentId: string,
  patch: { maxTxCents?: number | undefined; dailyLimitCents?: number | null | undefined },
) {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found", "AGENT_NOT_FOUND");
  const [existing] = await tx.select().from(policies).where(eq(policies.agentId, agentId)).for("update");
  const next = {
    maxTxCents: patch.maxTxCents ?? existing?.maxTxCents ?? DEFAULT_MAX_TX_CENTS,
    dailyLimitCents: patch.dailyLimitCents === undefined ? (existing?.dailyLimitCents ?? null) : patch.dailyLimitCents,
  };
  const now = new Date();
  if (!existing) await tx.insert(policies).values({ agentId, ...next });
  else await tx.update(policies).set({ ...next, updatedAt: now }).where(eq(policies.agentId, agentId));
  await writeAudit(tx, {
    eventType: "POLICY_UPDATED",
    orgId: agent.orgId,
    controllerId: agent.controllerId,
    agentId,
    metadata: { previous: existing ? { maxTxCents: existing.maxTxCents, dailyLimitCents: existing.dailyLimitCents } : null, ...next },
  });
  return { agentId, ...next };
}

/** Demo/admin funding. Mints money, so the route is admin-only. */
export async function fundWallet(tx: Db, agentId: string, amountCents: number, note?: string) {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound("Agent not found", "AGENT_NOT_FOUND");
  const balances = await lockWallets(tx, [agentId]);
  if (balances.get(agentId)! + amountCents > MAX_CENTS) {
    throw new AppError(422, "BALANCE_OVERFLOW", "Balance would exceed the maximum representable amount");
  }
  const [w] = await tx
    .update(wallets)
    .set({ balanceCents: balances.get(agentId)! + amountCents })
    .where(eq(wallets.agentId, agentId))
    .returning();
  const txId = await addLedger(tx, { agentId, type: "FUND", amountCents, note });
  await writeAudit(tx, {
    eventType: "WALLET_FUNDED",
    orgId: agent.orgId,
    controllerId: agent.controllerId,
    agentId,
    amountCents,
    txId,
    metadata: { note },
  });
  return { success: true as const, agentId, newBalanceCents: w!.balanceCents, txId };
}

