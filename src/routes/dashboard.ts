import { desc, eq, or } from "drizzle-orm";
import { Router } from "express";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { auditEvents } from "../db/schema";
import { clampLimit, esc, zUuid } from "../lib/http";
import { requireAdmin } from "../middleware/auth";
import { loadFeeds, loadStats } from "./admin";

const dollars = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #0f0f12; color: #e4e4e7; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; } h2 { font-size: 1.1rem; margin: 24px 0 12px; color: #a1a1aa; }
  a { color: #818cf8; text-decoration: none; } a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #27272a; padding: 8px 10px; text-align: left; }
  th { background: #18181b; color: #a1a1aa; } tr:hover { background: #18181b; }
  code { font-size: 11px; background: #27272a; padding: 2px 6px; border-radius: 4px; }
  .layout { max-width: 1120px; margin: 0 auto; } .subtitle { color: #a1a1aa; margin-bottom: 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0 28px; }
  .card { background: #18181b; border-radius: 10px; padding: 12px 14px; border: 1px solid #27272a; }
  .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #71717a; margin-bottom: 4px; }
  .card-value { font-size: 18px; font-weight: 600; } .card-detail { font-size: 11px; color: #a1a1aa; margin-top: 2px; }
  .section { margin-bottom: 32px; }`;

const page = (title: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="layout">
  <p><a href="/dashboard">Dashboard</a> | <a href="/audit-view">Audit log</a></p>${body}</div></body></html>`;

const card = (label: string, value: string | number, detail: string) =>
  `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value">${esc(value)}</div><div class="card-detail">${esc(detail)}</div></div>`;

const table = (heads: string[], rows: string[][], empty: string) =>
  `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}">${esc(empty)}</td></tr>`
  }</tbody></table>`;

const code = (v: unknown) => `<code>${esc(v)}</code>`;

/** Server-rendered operator views. Admin-gated (browser prompts for the token as the Basic-auth password); every value is HTML-escaped. */
export function dashboardRoutes(db: Db, config: Config): Router {
  const r = Router();
  const admin = requireAdmin(config, { basicChallenge: true });

  r.get("/dashboard", admin, async (_req, res) => {
    const [s, f] = await Promise.all([loadStats(db), loadFeeds(db, { agents: 100, escrows: 50, intents: 50, audit: 100 })]);
    res.type("html").send(
      page(
        "Proxify Dashboard",
        `<h1>Proxify Dashboard</h1><p class="subtitle">Agents, wallets, intents, escrows and the audit trail.</p>
        <div class="cards">
          ${card("Agents", s.totalAgents, `${s.activeAgents} active`)}
          ${card("Aggregate balance", dollars(s.totalWalletBalanceCents), "Sum across all wallets")}
          ${card("Open escrows", s.lockedEscrowsCount, `${dollars(s.lockedEscrowCents)} locked`)}
          ${card("Settled (24h)", dollars(s.settledVolumeLast24hCents), "Transfers, captures, releases")}
          ${card("Open intents", s.openIntentsCount, "Created, not captured")}
          ${card("Captured intents", s.capturedIntentsCount, "Settled via intents")}
          ${card("Cancelled / expired", `${s.cancelledIntentsCount} / ${s.expiredIntentsCount}`, "Intents")}
          ${card("Webhooks", `${s.webhookDeliveries.DELIVERED ?? 0} ok / ${s.webhookDeliveries.PENDING ?? 0} pending / ${s.webhookDeliveries.FAILED ?? 0} failed`, "Deliveries")}
        </div>
        <div class="section"><h2>Agents &amp; balances</h2>${table(
          ["Agent ID", "Org ID", "Status", "Balance", "Created"],
          f.agents.map((a) => [code(a.id), code(a.orgId), esc(a.status), esc(dollars(a.balanceCents ?? 0)), esc(a.createdAt.toISOString())]),
          "No agents yet - run the demo.",
        )}</div>
        <div class="section"><h2>Escrows</h2>${table(
          ["Escrow ID", "From", "To", "Amount", "Status", "Created"],
          f.escrows.map((e) => [code(e.id), code(e.fromAgentId), code(e.toAgentId), esc(dollars(e.amountCents)), esc(e.status), esc(e.createdAt.toISOString())]),
          "No escrows yet.",
        )}</div>
        <div class="section"><h2>Payment intents</h2>${table(
          ["Intent ID", "From", "To", "Amount", "Status", "Created"],
          f.intents.map((i) => [code(i.id), code(i.fromAgentId), code(i.toAgentId), esc(dollars(i.amountCents)), esc(i.status), esc(i.createdAt.toISOString())]),
          "No payment intents yet.",
        )}</div>
        <div class="section"><h2>Recent audit events</h2>${table(
          ["Time", "Event", "Agent", "Actor", "Target", "Amount", "Reason"],
          f.auditEvents.map((e) => [esc(e.createdAt.toISOString()), esc(e.eventType), esc(e.agentId), esc(e.actorAgentId), esc(e.targetAgentId), esc(dollars(e.amountCents)), esc((e.reason ?? "").slice(0, 80))]),
          "No events yet.",
        )}</div>`,
      ),
    );
  });

  r.get("/audit-view", admin, async (req, res) => {
    const rawAgent = typeof req.query.agentId === "string" && req.query.agentId ? req.query.agentId : undefined;
    const agentId = rawAgent && zUuid.safeParse(rawAgent).success ? rawAgent : undefined;
    const limit = clampLimit(req.query.limit, 200, 500);
    const events = await db
      .select()
      .from(auditEvents)
      .where(agentId ? or(eq(auditEvents.agentId, agentId), eq(auditEvents.actorAgentId, agentId)) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
    res.type("html").send(
      page(
        "Audit Log",
        `<h2>Audit log (latest ${limit})${agentId ? ` - agent ${esc(agentId)}` : ""}</h2>
        <p class="subtitle">Every funding, transfer, intent, policy change and escrow event leaves a trail here.</p>
        <form method="get" style="margin-bottom:16px"><label>Filter by agent ID&nbsp;<input type="text" name="agentId" value="${esc(agentId ?? "")}" placeholder="Agent UUID" /></label> <button type="submit">Apply</button></form>
        ${table(
          ["Time", "Event", "Org", "Agent", "Actor", "Target", "Amount", "Reason"],
          events.map((e) => [esc(e.createdAt.toISOString()), esc(e.eventType), esc(e.orgId), esc(e.agentId), esc(e.actorAgentId), esc(e.targetAgentId), esc(dollars(e.amountCents)), esc(e.reason)]),
          "No events.",
        )}`,
      ),
    );
  });

  return r;
}
