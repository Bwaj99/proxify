import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { agents, auditEvents, escrows, paymentIntents, wallets } from "../db/schema";
import { clampLimit, parse, zCents, zUuid } from "../lib/http";
import { requireAdmin } from "../middleware/auth";
import * as prov from "../services/provisioning";
import * as hooks from "../services/webhooks";

/** Operator surface: provisioning, funding, policy, suspension, org-wide audit, webhooks, stats. */
export function adminRoutes(db: Db, config: Config): Router {
  const r = Router();
  const admin = requireAdmin(config);

  r.post("/orgs", admin, async (req, res) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(200) }), req.body);
    const org = await db.transaction((tx) => prov.createOrg(tx, name));
    res.status(201).json({ orgId: org.id, name: org.name });
  });

  r.post("/controllers", admin, async (req, res) => {
    const body = parse(z.object({ orgId: zUuid, displayName: z.string().min(1).max(200) }), req.body);
    const c = await db.transaction((tx) => prov.createController(tx, body.orgId, body.displayName));
    res.status(201).json({ controllerId: c.id, orgId: c.orgId, displayName: c.displayName });
  });

  r.post("/agents/register", admin, async (req, res) => {
    const body = parse(
      z.object({
        orgId: zUuid,
        controllerId: zUuid,
        publicKeyPem: z.string().min(1).max(2000),
        maxTxCents: zCents.default(prov.DEFAULT_MAX_TX_CENTS),
        dailyLimitCents: zCents.optional(),
      }),
      req.body,
    );
    const agent = await db.transaction((tx) => prov.registerAgent(tx, body));
    res.status(201).json({ agentId: agent.id, orgId: agent.orgId, controllerId: agent.controllerId, status: agent.status });
  });

  r.patch("/agents/:agentId", admin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const { status } = parse(z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }), req.body);
    const agent = await db.transaction((tx) => prov.setAgentStatus(tx, agentId, status));
    res.json({ agentId, status: agent.status });
  });

  r.post("/agents/:agentId/wallet/fund", admin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const body = parse(z.object({ amountCents: zCents, note: z.string().max(500).optional() }), req.body);
    res.status(201).json(await db.transaction((tx) => prov.fundWallet(tx, agentId, body.amountCents, body.note)));
  });

  r.post("/agents/:agentId/policy", admin, async (req, res) => {
    const agentId = parse(zUuid, req.params.agentId);
    const body = parse(
      z
        .object({ maxTxCents: zCents.optional(), dailyLimitCents: zCents.nullable().optional() })
        .refine((b) => b.maxTxCents !== undefined || b.dailyLimitCents !== undefined, "provide maxTxCents and/or dailyLimitCents"),
      req.body,
    );
    const out = await db.transaction((tx) => prov.setPolicy(tx, agentId, body));
    res.status(201).json({ success: true, ...out });
  });

  // ---------------------------------------------------------------- org-wide audit (cursor-paginated)
  r.get("/audit", admin, async (req, res) => {
    const orgId = typeof req.query.orgId === "string" ? parse(zUuid, req.query.orgId) : undefined;
    const agentId = typeof req.query.agentId === "string" ? parse(zUuid, req.query.agentId) : undefined;
    const limit = clampLimit(req.query.limit, 100, 1000);
    const cursor = req.query.cursor !== undefined ? Number(req.query.cursor) : undefined;
    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          orgId ? eq(auditEvents.orgId, orgId) : undefined,
          agentId ? or(eq(auditEvents.agentId, agentId), eq(auditEvents.actorAgentId, agentId)) : undefined,
          cursor !== undefined && Number.isFinite(cursor) ? lt(auditEvents.seq, cursor) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
    res.json({ count: events.length, events, nextCursor: events.length === limit ? events[events.length - 1]!.seq : null });
  });

  // ---------------------------------------------------------------- webhooks
  r.post("/orgs/:orgId/webhooks", admin, async (req, res) => {
    const orgId = parse(zUuid, req.params.orgId);
    const { url } = parse(z.object({ url: z.string().min(1).max(2000) }), req.body);
    res.status(201).json(await hooks.createEndpoint(db, config, orgId, url));
  });
  r.get("/orgs/:orgId/webhooks", admin, async (req, res) => {
    res.json({ endpoints: await hooks.listEndpoints(db, parse(zUuid, req.params.orgId)) });
  });
  r.delete("/orgs/:orgId/webhooks/:endpointId", admin, async (req, res) => {
    await hooks.deactivateEndpoint(db, parse(zUuid, req.params.orgId), parse(zUuid, req.params.endpointId));
    res.status(204).end();
  });

  // ---------------------------------------------------------------- dashboard JSON (aggregates computed in SQL, not in Node)
  r.get("/dashboard/stats", admin, async (_req, res) => {
    res.json(await loadStats(db));
  });

  r.get("/dashboard/feeds", admin, async (req, res) => {
    const lim = (k: string, d: number, m: number) => clampLimit(req.query[k], d, m);
    res.json(await loadFeeds(db, { agents: lim("agentsLimit", 25, 100), escrows: lim("escrowsLimit", 25, 100), intents: lim("intentsLimit", 25, 100), audit: lim("auditLimit", 50, 200) }));
  });

  return r;
}

export async function loadStats(db: Db) {
  const [a, w, e, i, v, wh] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where ${agents.status} = 'ACTIVE')::int` }).from(agents),
    db.select({ total: sql<number>`coalesce(sum(${wallets.balanceCents}), 0)::float8` }).from(wallets),
    db
      .select({
        status: escrows.status,
        n: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${escrows.amountCents}), 0)::float8`,
      })
      .from(escrows)
      .groupBy(escrows.status),
    db.select({ status: paymentIntents.status, n: sql<number>`count(*)::int` }).from(paymentIntents).groupBy(paymentIntents.status),
    db
      .select({ total: sql<number>`coalesce(sum(${auditEvents.amountCents}), 0)::float8` })
      .from(auditEvents)
      .where(
        and(
          sql`${auditEvents.eventType} in ('TRANSFER_SUCCEEDED','INTENT_CAPTURED','ESCROW_RELEASED')`,
          sql`${auditEvents.createdAt} > now() - interval '24 hours'`,
        ),
      ),
    hooks.deliveryStats(db),
  ]);
  const escrowBy = Object.fromEntries(e.map((x) => [x.status, x]));
  const intentBy = Object.fromEntries(i.map((x) => [x.status, x.n]));
  return {
    totalAgents: a[0]?.n ?? 0,
    activeAgents: a[0]?.active ?? 0,
    totalWalletBalanceCents: Number(w[0]?.total ?? 0),
    lockedEscrowsCount: escrowBy.LOCKED?.n ?? 0,
    lockedEscrowCents: Number(escrowBy.LOCKED?.total ?? 0),
    releasedEscrowsCount: escrowBy.RELEASED?.n ?? 0,
    refundedEscrowsCount: escrowBy.REFUNDED?.n ?? 0,
    totalEscrowNotionalCents: e.reduce((s, x) => s + Number(x.total), 0),
    openIntentsCount: intentBy.CREATED ?? 0,
    capturedIntentsCount: intentBy.CAPTURED ?? 0,
    cancelledIntentsCount: intentBy.CANCELLED ?? 0,
    expiredIntentsCount: intentBy.EXPIRED ?? 0,
    settledVolumeLast24hCents: Number(v[0]?.total ?? 0),
    webhookDeliveries: wh,
  };
}

export async function loadFeeds(db: Db, l: { agents: number; escrows: number; intents: number; audit: number }) {
  const [agentsList, escrowsList, intentsList, auditList] = await Promise.all([
    db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        controllerId: agents.controllerId,
        status: agents.status,
        createdAt: agents.createdAt,
        balanceCents: wallets.balanceCents,
      })
      .from(agents)
      .leftJoin(wallets, eq(agents.id, wallets.agentId))
      .orderBy(desc(agents.createdAt))
      .limit(l.agents),
    db.select().from(escrows).orderBy(desc(escrows.createdAt)).limit(l.escrows),
    db.select().from(paymentIntents).orderBy(desc(paymentIntents.createdAt)).limit(l.intents),
    db.select().from(auditEvents).orderBy(desc(auditEvents.seq)).limit(l.audit),
  ]);
  return { agents: agentsList, escrows: escrowsList, intents: intentsList, auditEvents: auditList };
}
