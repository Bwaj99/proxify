/**
 * End-to-end walkthrough: a research agent hires a scraper agent through escrow.
 *
 *   npm run demo                       # zero setup: boots the API in-process on embedded Postgres
 *   PROXIFY_BASE_URL=http://localhost:3000 [ADMIN_TOKEN=...] npm run demo   # against a running server
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { ProxifyAdmin, ProxifyAgent, ProxifyError, formatDollars, generateAgentKeys } from "../sdk/agent";

const step = (n: number, msg: string) => console.log(`\n${n}. ${msg}`);
const expectError = async (label: string, p: Promise<unknown>) => {
  try {
    await p;
    console.log(`   ✗ ${label}: unexpectedly succeeded`);
  } catch (e) {
    if (e instanceof ProxifyError) console.log(`   ✓ ${label} -> ${e.statusCode} ${e.code}`);
    else throw e;
  }
};

async function main() {
  let server: Server | undefined;
  let closeDb: (() => Promise<void>) | undefined;
  let baseUrl = process.env.PROXIFY_BASE_URL;
  const adminToken = process.env.ADMIN_TOKEN || undefined;

  if (!baseUrl) {
    const config = { ...loadConfig({ NODE_ENV: "test" }), rateLimitPerMin: 0 };
    const handle = await createDb({});
    closeDb = handle.close;
    server = createApp(handle.db, config).listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    console.log(`(booted an in-process Proxify on ${baseUrl} with embedded Postgres)`);
  }

  const admin = new ProxifyAdmin(baseUrl, adminToken);

  step(1, "Provision an org, a controller, and two agents (each with its own Ed25519 key pair)");
  const org = await admin.createOrg("Acme AI");
  const controller = await admin.createController(org.orgId, "research-team");
  const kA = generateAgentKeys();
  const kB = generateAgentKeys();
  const a = await admin.registerAgent({ orgId: org.orgId, controllerId: controller.controllerId, publicKeyPem: kA.publicKeyPem, maxTxCents: 5_000, dailyLimitCents: 12_000 });
  const b = await admin.registerAgent({ orgId: org.orgId, controllerId: controller.controllerId, publicKeyPem: kB.publicKeyPem });
  const payer = new ProxifyAgent({ baseUrl, agentId: a.agentId, privateKeyPem: kA.privateKeyPem });
  const worker = new ProxifyAgent({ baseUrl, agentId: b.agentId, privateKeyPem: kB.privateKeyPem });
  await admin.fund(a.agentId, 20_000, "seed funding");
  console.log(`   payer  ${a.agentId}  balance ${formatDollars((await payer.getBalance()).balanceCents)}  (max/tx $50, $120/day)`);

  step(2, "Payer locks $30 in escrow for the worker");
  const escrow = await payer.createEscrow(b.agentId, 3_000, "scrape 500 product pages");
  console.log(`   payer balance now ${formatDollars(escrow.fromNewBalanceCents)}; worker still ${formatDollars((await worker.getBalance()).balanceCents)}`);

  step(3, "Worker verifies the funds are reserved, then tries things it must not be able to do");
  const seen = await worker.getEscrow(escrow.escrowId);
  console.log(`   worker sees escrow ${seen.status} for ${formatDollars(seen.amountCents)}`);
  await expectError("worker releases its own escrow", worker.releaseEscrow(escrow.escrowId));
  await expectError("worker reads the payer's wallet", (worker as any).request("GET", `/v1/agents/${a.agentId}/wallet`));

  step(4, "Payer confirms the work and releases");
  const released = await payer.releaseEscrow(escrow.escrowId);
  console.log(`   worker balance ${formatDollars(released.toNewBalanceCents)}`);
  await expectError("second release", payer.releaseEscrow(escrow.escrowId));

  step(5, "Spending policy is enforced server-side, even for a perfectly signed request");
  await expectError("$50.01 transfer (limit $50.00)", payer.transfer(b.agentId, 5_001));

  step(6, "Retries are safe: same Idempotency-Key = one transfer");
  const t1 = await payer.transfer(b.agentId, 1_000, "invoice-42", "invoice-42");
  const t2 = await payer.transfer(b.agentId, 1_000, "invoice-42", "invoice-42");
  console.log(`   same transfer replayed: ${t1.txOutId === t2.txOutId}; worker balance ${formatDollars((await worker.getBalance()).balanceCents)}`);

  step(7, "Payment intent: authorise now, capture later");
  const { intent } = await payer.createIntent(b.agentId, 500, { note: "bonus" });
  const cap = await payer.captureIntent(intent.id);
  console.log(`   captured ${formatDollars(cap.amountCents)}; worker balance ${formatDollars(cap.toNewBalanceCents)}`);

  step(8, "Kill-switch: suspend the worker; its signed requests stop working immediately");
  await admin.setStatus(b.agentId, "SUSPENDED");
  await expectError("suspended worker reads its balance", worker.getBalance());

  step(9, "Audit trail for the payer");
  const audit = await payer.getAudit(50);
  for (const e of [...audit.events].reverse()) {
    console.log(`   ${String(e.seq).padStart(3)} ${e.eventType.padEnd(20)} ${e.amountCents != null ? formatDollars(e.amountCents) : ""} ${e.reason ?? ""}`);
  }

  if (server) await new Promise((r) => server!.close(r));
  await closeDb?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
