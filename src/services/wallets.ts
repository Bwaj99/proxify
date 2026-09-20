import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, ledgerTxs, policies, wallets } from "../db/schema";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { MAX_CENTS } from "../lib/http";

export type LedgerType = "FUND" | "TRANSFER_OUT" | "TRANSFER_IN" | "ESCROW_LOCK" | "ESCROW_RELEASE" | "ESCROW_REFUND";

/**
 * Lock wallet rows (SELECT ... FOR UPDATE) in sorted-id order. Concurrent
 * A->B and B->A operations therefore take locks in the same order and cannot
 * deadlock, and read-check-write on balances is serialised per wallet.
 */
export async function lockWallets(tx: Db, ids: string[]): Promise<Map<string, number>> {
  const uniq = [...new Set(ids)].sort();
  const rows = await tx
    .select({ agentId: wallets.agentId, balance: wallets.balanceCents })
    .from(wallets)
    .where(inArray(wallets.agentId, uniq))
    .orderBy(wallets.agentId)
    .for("update");
  const map = new Map(rows.map((r) => [r.agentId, r.balance]));
  for (const id of uniq) if (!map.has(id)) throw notFound("Wallet not found", "WALLET_NOT_FOUND");
  return map;
}

/** Atomic relative update (never write back a value computed from an earlier read). Returns the new balance. */
export async function adjustBalance(tx: Db, agentId: string, deltaCents: number): Promise<number> {
  const [row] = await tx
    .update(wallets)
    .set({ balanceCents: sql`${wallets.balanceCents} + ${deltaCents}` })
    .where(eq(wallets.agentId, agentId))
    .returning({ balance: wallets.balanceCents });
  return row!.balance;
}

export function assertCreditable(balance: number, amountCents: number): void {
  if (balance + amountCents > MAX_CENTS) {
    throw new AppError(422, "BALANCE_OVERFLOW", "Recipient balance would exceed the maximum representable amount");
  }
}

export function assertSufficient(balance: number, amountCents: number): void {
  if (balance < amountCents) {
    throw new AppError(402, "INSUFFICIENT_FUNDS", "Insufficient funds", { balanceCents: balance, requiredCents: amountCents });
  }
}

export async function addLedger(
  tx: Db,
  e: {
    agentId: string;
    type: LedgerType;
    amountCents: number;
    counterpartyAgentId?: string | undefined;
    escrowId?: string | undefined;
    note?: string | null | undefined;
  },
): Promise<string> {
  const [row] = await tx
    .insert(ledgerTxs)
    .values({
      agentId: e.agentId,
      type: e.type,
      amountCents: e.amountCents,
      counterpartyAgentId: e.counterpartyAgentId ?? null,
      escrowId: e.escrowId ?? null,
      note: e.note ?? null,
    })
    .returning({ id: ledgerTxs.id });
  return row!.id;
}

/**
 * Per-transaction cap and rolling-24h cap. For the daily cap to be race-free
 * the caller must already hold the payer's wallet lock: concurrent spends by
 * the same agent are then serialised, so each sees the previous one's ledger row.
 */
export async function enforcePolicy(tx: Db, agentId: string, amountCents: number, opts: { daily?: boolean } = {}): Promise<void> {
  const [policy] = await tx.select().from(policies).where(eq(policies.agentId, agentId));
  if (!policy) throw notFound("Policy not found for sender", "POLICY_NOT_FOUND");
  if (amountCents > policy.maxTxCents) {
    throw forbidden("Amount exceeds policy maxTxCents", "POLICY_VIOLATION", {
      maxTxCents: policy.maxTxCents,
      attemptedAmountCents: amountCents,
    });
  }
  if ((opts.daily ?? true) && policy.dailyLimitCents != null) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [usage] = await tx
      .select({ total: sql<number>`coalesce(sum(${ledgerTxs.amountCents}), 0)::float8` })
      .from(ledgerTxs)
      .where(
        and(
          eq(ledgerTxs.agentId, agentId),
          inArray(ledgerTxs.type, ["TRANSFER_OUT", "ESCROW_LOCK"]),
          gte(ledgerTxs.createdAt, since),
        ),
      );
    const spent = Number(usage?.total ?? 0);
    if (spent + amountCents > policy.dailyLimitCents) {
      throw forbidden("Amount exceeds rolling 24h spending limit", "DAILY_LIMIT_EXCEEDED", {
        dailyLimitCents: policy.dailyLimitCents,
        spentLast24hCents: spent,
        attemptedAmountCents: amountCents,
      });
    }
  }
}

/** Counterparty must exist and be ACTIVE. */
export async function requireActiveAgent(tx: Db, agentId: string, label: string) {
  const [a] = await tx.select().from(agents).where(eq(agents.id, agentId));
  if (!a) throw notFound(`${label} agent not found`, "AGENT_NOT_FOUND");
  if (a.status !== "ACTIVE") throw conflict(`${label} agent is suspended`, "AGENT_SUSPENDED");
  return a;
}
