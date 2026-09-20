import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, ledgerTxs } from "../src/db/schema";
import { balance, errCode, newAgent, rawSigned, startEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => void (env = await startEnv()));
afterAll(async () => env.close());

describe("transfers", () => {
  it("moves exact integer cents, writes both ledger rows and an audit event", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const t = await a.client.transfer(b.id, 250, "hello");
    expect(t).toMatchObject({ fromNewBalanceCents: 750, toNewBalanceCents: 250 });
    expect(await balance(a)).toBe(750);
    expect(await balance(b)).toBe(250);
    const rows = await env.handle.db.select().from(ledgerTxs).where(eq(ledgerTxs.agentId, b.id));
    expect(rows.map((r) => r.type)).toContain("TRANSFER_IN");
    expect((await a.client.getAudit()).events.map((e) => e.eventType)).toContain("TRANSFER_SUCCEEDED");
  });

  it("rejects overdrafts, self-transfers, non-integer / non-positive / huge amounts, unknown recipients", async () => {
    const a = await newAgent(env, { fund: 100 });
    const b = await newAgent(env);
    expect(await errCode(a.client.transfer(b.id, 101))).toBe("INSUFFICIENT_FUNDS");
    expect(await errCode(a.client.transfer(a.id, 1))).toBe("SELF_TRANSFER");
    expect(await errCode(a.client.transfer(b.id, 0.5))).toBe("VALIDATION_ERROR");
    expect(await errCode(a.client.transfer(b.id, -5))).toBe("VALIDATION_ERROR");
    expect(await errCode(a.client.transfer(b.id, Number.MAX_SAFE_INTEGER + 2))).toBe("VALIDATION_ERROR");
    expect(await errCode(a.client.transfer("00000000-0000-4000-8000-000000000000", 1))).toBe("AGENT_NOT_FOUND");
    expect(await balance(a)).toBe(100);
  });

  it("enforces per-transaction policy even with a valid signature; failures are audited", async () => {
    const a = await newAgent(env, { fund: 100_000, maxTxCents: 500 });
    const b = await newAgent(env);
    expect(await errCode(a.client.transfer(b.id, 501))).toBe("POLICY_VIOLATION");
    expect((await a.client.transfer(b.id, 500)).amountCents).toBe(500);
    const failed = (await a.client.getAudit()).events.find((e) => e.eventType === "TRANSFER_FAILED");
    expect(failed?.reason).toMatch(/maxTxCents/);
    await env.admin.setPolicy(a.id, { maxTxCents: 1_000 });
    expect((await a.client.transfer(b.id, 1_000)).amountCents).toBe(1_000);
  });

  it("enforces a rolling 24h limit across transfers and escrows", async () => {
    const a = await newAgent(env, { fund: 100_000, maxTxCents: 1_000, dailyLimitCents: 2_500 });
    const b = await newAgent(env);
    await a.client.transfer(b.id, 1_000);
    await a.client.createEscrow(b.id, 1_000);
    expect(await errCode(a.client.transfer(b.id, 501))).toBe("DAILY_LIMIT_EXCEEDED");
    expect((await a.client.transfer(b.id, 500)).amountCents).toBe(500);
    await env.admin.setPolicy(a.id, { dailyLimitCents: null }); // lift the cap
    expect((await a.client.transfer(b.id, 1_000)).amountCents).toBe(1_000);
  });

  it("never oversells under concurrency: 12 parallel transfers vs. funds for 5", async () => {
    const a = await newAgent(env, { fund: 500 });
    const b = await newAgent(env);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => a.client.transfer(b.id, 100)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await balance(a)).toBe(0);
    expect(await balance(b)).toBe(500);
  });

  it("opposing transfers (A->B and B->A) at the same time neither deadlock nor lose money", async () => {
    const a = await newAgent(env, { fund: 10_000 });
    const b = await newAgent(env, { fund: 10_000 });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a.client.transfer(b.id, 100) : b.client.transfer(a.id, 100))),
    );
    expect((await balance(a)) + (await balance(b))).toBe(20_000);
  });
});

describe("idempotency", () => {
  it("a retried transfer with the same key happens once and replays the response", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const first = await a.client.transfer(b.id, 300, undefined, "key-1");
    const second = await a.client.transfer(b.id, 300, undefined, "key-1"); // fresh nonce+signature, same key
    expect(second.txOutId).toBe(first.txOutId);
    expect(await balance(a)).toBe(700);
    expect(await balance(b)).toBe(300);
  });

  it("concurrent duplicates with one key still move money exactly once", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const results = await Promise.all(Array.from({ length: 6 }, () => a.client.transfer(b.id, 100, undefined, "same-key")));
    expect(new Set(results.map((r) => r.txOutId)).size).toBe(1);
    expect(await balance(b)).toBe(100);
  });

  it("rejects the same key reused for a different request", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    await a.client.transfer(b.id, 100, undefined, "key-2");
    expect(await errCode(a.client.transfer(b.id, 200, undefined, "key-2"))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("keys are scoped per agent: another agent can't read or collide with yours", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const c = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const t1 = await a.client.transfer(b.id, 100, undefined, "shared-key");
    const t2 = await c.client.transfer(b.id, 100, undefined, "shared-key");
    expect(t1.txOutId).not.toBe(t2.txOutId);
    expect(await balance(b)).toBe(200);
  });

  it("is required on transfers", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const req = rawSigned(a, "POST", "/v1/tx/transfer", JSON.stringify({ toAgentId: b.id, amountCents: 1 }));
    const res = await fetch(env.baseUrl + "/v1/tx/transfer", req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("a failed attempt does not burn the key", async () => {
    const a = await newAgent(env, { fund: 50 });
    const b = await newAgent(env);
    expect(await errCode(a.client.transfer(b.id, 100, undefined, "key-3"))).toBe("INSUFFICIENT_FUNDS");
    await env.admin.fund(a.id, 100);
    expect((await a.client.transfer(b.id, 100, undefined, "key-3")).amountCents).toBe(100);
  });
});

describe("escrow", () => {
  it("locks funds, lets the worker verify, and only the payer can release (once)", async () => {
    const payer = await newAgent(env, { fund: 1_000 });
    const worker = await newAgent(env);
    const e = await payer.client.createEscrow(worker.id, 400);
    expect(await balance(payer)).toBe(600);
    expect(await balance(worker)).toBe(0);
    expect((await worker.client.getEscrow(e.escrowId)).status).toBe("LOCKED");

    expect(await errCode(worker.client.releaseEscrow(e.escrowId))).toBe("NOT_PAYER");
    expect(await balance(worker)).toBe(0);
    await payer.client.releaseEscrow(e.escrowId);
    expect(await balance(worker)).toBe(400);
    expect(await errCode(payer.client.releaseEscrow(e.escrowId))).toBe("ESCROW_NOT_LOCKED");
    expect(await errCode(worker.client.refundEscrow(e.escrowId))).toBe("ESCROW_NOT_LOCKED");
    expect(await balance(worker)).toBe(400);
  });

  it("the worker can refund the payer; the payer cannot refund itself", async () => {
    const payer = await newAgent(env, { fund: 1_000 });
    const worker = await newAgent(env);
    const e = await payer.client.createEscrow(worker.id, 400);
    expect(await errCode(payer.client.refundEscrow(e.escrowId))).toBe("NOT_RECIPIENT");
    await worker.client.refundEscrow(e.escrowId);
    expect(await balance(payer)).toBe(1_000);
    expect(await balance(worker)).toBe(0);
    expect((await payer.client.getEscrow(e.escrowId)).status).toBe("REFUNDED");
    expect(await errCode(payer.client.releaseEscrow(e.escrowId))).toBe("ESCROW_NOT_LOCKED");
  });

  it("concurrent release + refund settle exactly once; total money is conserved", async () => {
    const payer = await newAgent(env, { fund: 1_000 });
    const worker = await newAgent(env);
    const e = await payer.client.createEscrow(worker.id, 400);
    const results = await Promise.allSettled([
      payer.client.releaseEscrow(e.escrowId),
      payer.client.releaseEscrow(e.escrowId),
      worker.client.refundEscrow(e.escrowId),
      worker.client.refundEscrow(e.escrowId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await balance(payer)) + (await balance(worker))).toBe(1_000);
  });

  it("hides escrows from uninvolved agents and enforces the policy limit", async () => {
    const payer = await newAgent(env, { fund: 5_000, maxTxCents: 1_000 });
    const worker = await newAgent(env);
    const outsider = await newAgent(env);
    expect(await errCode(payer.client.createEscrow(worker.id, 1_001))).toBe("POLICY_VIOLATION");
    const e = await payer.client.createEscrow(worker.id, 1_000);
    expect(await errCode(outsider.client.getEscrow(e.escrowId))).toBe("ESCROW_NOT_FOUND");
  });

  it("refuses to pay a suspended recipient, but a locked escrow still settles", async () => {
    const payer = await newAgent(env, { fund: 2_000 });
    const worker = await newAgent(env);
    const e = await payer.client.createEscrow(worker.id, 500);
    await env.admin.setStatus(worker.id, "SUSPENDED");
    expect(await errCode(payer.client.createEscrow(worker.id, 100))).toBe("AGENT_SUSPENDED");
    await payer.client.releaseEscrow(e.escrowId);
    expect((await env.admin.getWallet(worker.id)).balanceCents).toBe(500);
  });
});

describe("payment intents", () => {
  it("create -> capture moves funds once; only the payer can capture", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const { intent } = await a.client.createIntent(b.id, 300, { note: "bonus" });
    expect(await balance(a)).toBe(1_000); // nothing moved yet
    expect(await errCode(b.client.captureIntent(intent.id))).toBe("NOT_PAYER");
    await a.client.captureIntent(intent.id);
    expect(await balance(b)).toBe(300);
    expect(await errCode(a.client.captureIntent(intent.id))).toBe("INTENT_NOT_CAPTURABLE");
    expect((await b.client.getIntent(intent.id)).status).toBe("CAPTURED");
  });

  it("concurrent captures move money once", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const { intent } = await a.client.createIntent(b.id, 300);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => a.client.captureIntent(intent.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(b)).toBe(300);
  });

  it("expired intents can't be captured and are marked EXPIRED", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const { intent } = await a.client.createIntent(b.id, 300, { expiresAt: new Date(Date.now() + 1_500).toISOString() });
    await new Promise((r) => setTimeout(r, 1_800));
    expect(await errCode(a.client.captureIntent(intent.id))).toBe("INTENT_EXPIRED");
    expect((await a.client.getIntent(intent.id)).status).toBe("EXPIRED");
    expect(await balance(b)).toBe(0);
  });

  it("cancel works before capture, not after", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const { intent } = await a.client.createIntent(b.id, 300);
    await a.client.cancelIntent(intent.id);
    expect(await errCode(a.client.captureIntent(intent.id))).toBe("INTENT_NOT_CAPTURABLE");
    expect(await errCode(a.client.cancelIntent(intent.id))).toBe("INTENT_NOT_CANCELLABLE");
  });
});

describe("ledger & audit log", () => {
  it("audit is append-only at the database level", async () => {
    const a = await newAgent(env, { fund: 10 });
    const db = env.handle.db;
    const { sql } = await import("drizzle-orm");
    await expect(db.execute(sql`update audit_events set event_type = 'x' where agent_id = ${a.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_events where agent_id = ${a.id}`)).rejects.toThrow();
    await expect(db.execute(sql`truncate audit_events`)).rejects.toThrow();
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.agentId, a.id)));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("paginates the ledger and audit log with stable cursors", async () => {
    const a = await newAgent(env, { fund: 10_000 });
    const b = await newAgent(env);
    for (let i = 0; i < 5; i++) await a.client.transfer(b.id, 10);
    const page1 = await a.client.getAudit(3);
    expect(page1.events).toHaveLength(3);
    const page2 = await a.client.getAudit(3, page1.nextCursor!);
    expect(page2.events.every((e) => e.seq < page1.nextCursor!)).toBe(true);
    const ids = new Set([...page1.events, ...page2.events].map((e) => e.id));
    expect(ids.size).toBe(page1.events.length + page2.events.length);
    const ledger = await a.client.getLedger({ limit: 2 });
    expect(ledger.transactions).toHaveLength(2);
    expect(ledger.nextBefore).toBeTruthy();
  });

  it("dashboard stats are computed in SQL and reflect activity", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    await a.client.createEscrow(b.id, 200);
    const stats = (await env.admin.getStats()) as any;
    expect(stats.totalAgents).toBeGreaterThanOrEqual(2);
    expect(stats.lockedEscrowsCount).toBeGreaterThanOrEqual(1);
    expect(stats.lockedEscrowCents).toBeGreaterThanOrEqual(200);
  });
});
