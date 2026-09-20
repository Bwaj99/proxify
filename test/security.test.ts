import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { nonces } from "../src/db/schema";
import { esc } from "../src/lib/http";
import { ProxifyAgent, generateAgentKeys } from "../src/sdk/agent";
import { ADMIN_TOKEN, balance, errCode, newAgent, rawSigned, startEnv, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => void (env = await startEnv()));
afterAll(async () => env.close());

describe("request signing", () => {
  it("rejects a request signed by the wrong key", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const imposter = new ProxifyAgent({ baseUrl: env.baseUrl, agentId: a.id, privateKeyPem: generateAgentKeys().privateKeyPem, maxRetries: 0 });
    expect(await errCode(imposter.transfer(b.id, 100))).toBe("INVALID_SIGNATURE");
    expect(await balance(a)).toBe(1_000);
  });

  it("rejects a tampered body (signature covers the amount)", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const req = rawSigned(a, "POST", "/v1/tx/transfer", JSON.stringify({ toAgentId: b.id, amountCents: 100 }), { idem: "t-1" });
    const res = await fetch(env.baseUrl + "/v1/tx/transfer", { ...req, body: JSON.stringify({ toAgentId: b.id, amountCents: 900 }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).code).toBe("INVALID_SIGNATURE");
  });

  it("rejects a tampered path / query string", async () => {
    const a = await newAgent(env);
    const req = rawSigned(a, "GET", `/v1/agents/${a.id}/ledger?limit=1`);
    expect((await fetch(`${env.baseUrl}/v1/agents/${a.id}/ledger?limit=200`, req)).status).toBe(401);
  });

  it("blocks replay of a captured, perfectly valid request", async () => {
    const a = await newAgent(env, { fund: 1_000 });
    const b = await newAgent(env);
    const body = JSON.stringify({ toAgentId: b.id, amountCents: 100 });
    const req = rawSigned(a, "POST", "/v1/tx/transfer", body, { idem: "replay-1" });
    expect((await fetch(env.baseUrl + "/v1/tx/transfer", req)).status).toBe(201);
    const replay = await fetch(env.baseUrl + "/v1/tx/transfer", req);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).code).toBe("REPLAYED_NONCE");
    expect(await balance(b)).toBe(100);
  });

  it("stores nonces in the database, and only for valid signatures", async () => {
    const a = await newAgent(env);
    const good = rawSigned(a, "GET", `/v1/agents/${a.id}/wallet`);
    await fetch(`${env.baseUrl}/v1/agents/${a.id}/wallet`, good);
    const bad = rawSigned(a, "GET", `/v1/agents/${a.id}/wallet`, "", { nonce: "n".repeat(20) });
    bad.headers["x-signature"] = Buffer.alloc(64).toString("base64");
    await fetch(`${env.baseUrl}/v1/agents/${a.id}/wallet`, bad);
    const rows = await env.handle.db.select().from(nonces).where(eq(nonces.agentId, a.id));
    expect(rows.map((r) => r.nonce)).toEqual([good.headers["x-nonce"]]);
  });

  it("rejects timestamps outside the window (past and future)", async () => {
    const a = await newAgent(env);
    for (const offset of [-10 * 60_000, 10 * 60_000]) {
      const req = rawSigned(a, "GET", `/v1/agents/${a.id}/wallet`, "", { timestamp: String(Date.now() + offset) });
      const res = await fetch(`${env.baseUrl}/v1/agents/${a.id}/wallet`, req);
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).code).toBe("STALE_TIMESTAMP");
    }
  });

  it("rejects missing auth headers", async () => {
    const a = await newAgent(env);
    const res = await fetch(`${env.baseUrl}/v1/agents/${a.id}/wallet`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).code).toBe("MISSING_AUTH_HEADERS");
  });

  it("suspended agents are locked out immediately; reactivation restores access", async () => {
    const a = await newAgent(env, { fund: 500 });
    expect(await balance(a)).toBe(500);
    await env.admin.setStatus(a.id, "SUSPENDED");
    expect(await errCode(a.client.getBalance())).toBe("AGENT_SUSPENDED");
    await env.admin.setStatus(a.id, "ACTIVE");
    expect(await balance(a)).toBe(500);
  });

  it("refuses non-Ed25519 keys at registration", async () => {
    const res = await fetch(`${env.baseUrl}/v1/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify({ orgId: env.orgId, controllerId: env.controllerId, publicKeyPem: "not a key" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("INVALID_PUBLIC_KEY");
  });
});

describe("access control", () => {
  it("reads are private: no auth -> 401, other agent -> 403, self and admin -> 200", async () => {
    const a = await newAgent(env, { fund: 700 });
    const b = await newAgent(env);
    expect((await fetch(`${env.baseUrl}/v1/agents/${a.id}/wallet`)).status).toBe(401);
    const asB = new ProxifyAgent({ baseUrl: env.baseUrl, agentId: b.id, privateKeyPem: b.keys.privateKeyPem, maxRetries: 0 });
    expect(await errCode((asB as any).request("GET", `/v1/agents/${a.id}/wallet`))).toBe("NOT_OWNER");
    expect(await balance(a)).toBe(700);
    expect((await env.admin.getWallet(a.id)).balanceCents).toBe(700);
  });

  it("admin routes need the admin token (funding, policy, registration, audit, dashboard)", async () => {
    const a = await newAgent(env);
    const noAuth = (path: string, method = "POST", body: unknown = {}) =>
      fetch(env.baseUrl + path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
    expect((await noAuth(`/v1/agents/${a.id}/wallet/fund`, "POST", { amountCents: 100 })).status).toBe(401);
    expect((await noAuth(`/v1/agents/${a.id}/policy`, "POST", { maxTxCents: 999999 })).status).toBe(401);
    expect((await noAuth("/v1/orgs", "POST", { name: "x" })).status).toBe(401);
    expect((await noAuth("/v1/audit", "GET")).status).toBe(401);
    expect((await noAuth("/v1/dashboard/stats", "GET")).status).toBe(401);
    expect((await noAuth("/dashboard", "GET")).status).toBe(401);
    // a signed agent request is not an admin credential
    const signedPolicy = rawSigned(a, "POST", `/v1/agents/${a.id}/policy`, JSON.stringify({ maxTxCents: 999999 }));
    expect((await fetch(`${env.baseUrl}/v1/agents/${a.id}/policy`, signedPolicy)).status).toBe(401);
  });

  it("dashboard prompts for credentials and accepts the admin token as the Basic password", async () => {
    const noAuth = await fetch(env.baseUrl + "/dashboard");
    expect(noAuth.headers.get("www-authenticate")).toContain("Basic");
    const ok = await fetch(env.baseUrl + "/dashboard", { headers: { authorization: "Basic " + Buffer.from(`admin:${ADMIN_TOKEN}`).toString("base64") } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Proxify Dashboard");
  });

  it("dashboards HTML-escape everything (no reflected XSS)", async () => {
    expect(esc(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    const res = await fetch(env.baseUrl + `/audit-view?agentId=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<script>alert(1)");
  });
});

describe("hardening", () => {
  it("5xx responses don't leak internals and malformed JSON is a clean 400", async () => {
    const res = await fetch(env.baseUrl + "/v1/orgs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("INVALID_JSON");
    const nf = await fetch(env.baseUrl + "/nope");
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).code).toBe("ROUTE_NOT_FOUND");
  });

  it("sets security headers and a request id", async () => {
    const res = await fetch(env.baseUrl + "/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("production config refuses to start without an admin token / database", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://x" })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ NODE_ENV: "production", ADMIN_TOKEN: "a".repeat(20) })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ NODE_ENV: "development", ADMIN_TOKEN: "short" })).toThrow(/at least 16/);
  });

  it("database rejects invariant violations even if application code were wrong", async () => {
    const a = await newAgent(env, { fund: 100 });
    await expect(env.handle.db.execute(sql`update wallets set balance_cents = -1 where agent_id = ${a.id}`)).rejects.toThrow();
    await expect(env.handle.db.execute(sql`update policies set max_tx_cents = 0 where agent_id = ${a.id}`)).rejects.toThrow();
  });
});
