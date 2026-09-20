import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditEvents, webhookDeliveries, webhookEndpoints } from "../db/schema";

export interface AuditInput {
  eventType: string;
  orgId?: string | undefined;
  controllerId?: string | undefined;
  agentId?: string | undefined;
  actorAgentId?: string | undefined;
  targetAgentId?: string | undefined;
  escrowId?: string | undefined;
  txId?: string | undefined;
  amountCents?: number | undefined;
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Extra orgs whose webhooks should hear about this event (e.g. the recipient's org). */
  notifyOrgIds?: (string | undefined)[];
}

/**
 * Writes the audit event and, in the same transaction, enqueues a webhook
 * delivery for every active endpoint of the involved orgs (transactional
 * outbox: an event is delivered if and only if the change it describes committed).
 * Always pass the caller's transaction handle.
 */
export async function writeAudit(tx: Db, e: AuditInput) {
  const { notifyOrgIds, ...fields } = e;
  const [row] = await tx
    .insert(auditEvents)
    .values({
      eventType: fields.eventType,
      orgId: fields.orgId ?? null,
      controllerId: fields.controllerId ?? null,
      agentId: fields.agentId ?? null,
      actorAgentId: fields.actorAgentId ?? null,
      targetAgentId: fields.targetAgentId ?? null,
      escrowId: fields.escrowId ?? null,
      txId: fields.txId ?? null,
      amountCents: fields.amountCents ?? null,
      reason: fields.reason ?? null,
      metadata: fields.metadata ?? null,
    })
    .returning();

  const orgIds = [...new Set([e.orgId, ...(notifyOrgIds ?? [])].filter((x): x is string => !!x))];
  if (orgIds.length > 0) {
    const endpoints = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(and(inArray(webhookEndpoints.orgId, orgIds), eq(webhookEndpoints.active, true)));
    if (endpoints.length > 0) {
      const payload = { id: row!.id, type: row!.eventType, createdAt: row!.createdAt, data: webhookData(row!) };
      await tx
        .insert(webhookDeliveries)
        .values(endpoints.map((ep) => ({ endpointId: ep.id, auditEventId: row!.id, payload })));
    }
  }
  return row!;
}

function webhookData(r: typeof auditEvents.$inferSelect) {
  return {
    orgId: r.orgId,
    agentId: r.agentId,
    actorAgentId: r.actorAgentId,
    targetAgentId: r.targetAgentId,
    escrowId: r.escrowId,
    txId: r.txId,
    amountCents: r.amountCents,
    reason: r.reason,
    metadata: r.metadata,
  };
}

/**
 * Failure events are written outside the (rolled back) business transaction.
 * Recording must never mask the original error.
 */
export async function recordFailure(db: Db, e: AuditInput): Promise<void> {
  try {
    await db.transaction((tx) => writeAudit(tx, e));
  } catch (err) {
    console.error("failed to record audit failure event:", err);
  }
}
