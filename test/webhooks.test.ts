import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhookDeliveries } from "../src/db/schema";
import { deliverDue } from "../src/services/webhooks";
import { newAgent, startEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let receiver: Server;
let receiverUrl: string;
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let respondWith = 200;

beforeAll(async () => {
  env = await startEnv({ webhooksEnabled: false }); // the test drives delivery explicitly
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  receiver.close();
  await env.close();
});

const makeDue = () =>
  env.handle.db.update(webhookDeliveries).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(webhookDeliveries.status, "PENDING"));

describe("webhooks", () => {
  it("delivers signed events for committed changes (transactional outbox)", async () => {
    const ep = await env.admin.createWebhook(env.orgId, receiverUrl);
    expect(ep.secret).toMatch(/^whsec_/);
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    await a.client.transfer(b.id, 100, "for webhook test");

    received.length = 0;
    await makeDue();
    await deliverDue(env.handle.db, env.config);
    const ev = received.map((r) => ({ ...r, json: JSON.parse(r.body) })).find((r) => r.json.type === "TRANSFER_SUCCEEDED");
    expect(ev).toBeTruthy();
    expect(ev!.json.data).toMatchObject({ agentId: a.id, targetAgentId: b.id, amountCents: 100 });

    // signature: t=<sec>,v1=hmac_sha256(secret, "<t>.<body>")
    const sig = String(ev!.headers["x-proxify-signature"]);
    const [t, v1] = sig.split(",").map((p) => p.split("=")[1]!);
    expect(v1).toBe(createHmac("sha256", ep.secret).update(`${t}.${ev!.body}`).digest("hex"));
    expect(ev!.headers["x-proxify-event-id"]).toBe(ev!.json.id);
  });

  it("does not emit an event for a rolled-back change", async () => {
    const a = await newAgent(env, { fund: 50 });
    const b = await newAgent(env);
    await makeDue();
    await deliverDue(env.handle.db, env.config); // drain
    received.length = 0;
    await a.client.transfer(b.id, 100).catch(() => {}); // insufficient funds -> rolled back
    await makeDue();
    await deliverDue(env.handle.db, env.config);
    const types = received.map((r) => JSON.parse(r.body).type);
    expect(types).not.toContain("TRANSFER_SUCCEEDED");
    expect(types).toContain("TRANSFER_FAILED"); // the failure itself is a committed audit event
  });

  it("retries failures with backoff and gives up after the max attempts", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    await makeDue();
    await deliverDue(env.handle.db, env.config); // drain earlier events
    respondWith = 500;
    await a.client.transfer(b.id, 10);
    received.length = 0;

    await makeDue();
    await deliverDue(env.handle.db, { webhookMaxAttempts: 2 });
    const [failing] = await env.handle.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, "PENDING"));
    expect(failing!.attempts).toBe(1);
    expect(failing!.lastError).toBe("HTTP 500");
    expect(failing!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backed off, not hammering

    await makeDue();
    await deliverDue(env.handle.db, { webhookMaxAttempts: 2 });
    const failed = await env.handle.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, "FAILED"));
    expect(failed.length).toBeGreaterThan(0);

    respondWith = 200;
  });

  it("only accepts https URLs in secure configurations, and never embedded credentials", async () => {
    const strict = await startEnv({ allowInsecureWebhooks: false });
    try {
      await expect(strict.admin.createWebhook(strict.orgId, "http://example.com/hook")).rejects.toMatchObject({ code: "INVALID_WEBHOOK_URL" });
      await expect(strict.admin.createWebhook(strict.orgId, "https://user:pw@example.com/hook")).rejects.toMatchObject({ code: "INVALID_WEBHOOK_URL" });
      await expect(strict.admin.createWebhook(strict.orgId, "https://example.com/hook")).resolves.toMatchObject({ url: "https://example.com/hook" });
    } finally {
      await strict.close();
    }
  });
});
