/**
 * Proxify demo — full intent lifecycle + escrow
 *
 * Flow:
 * 1. Register A & B
 * 2. Fund A
 * 3. Set policy
 * 4. Create + capture one intent
 * 5. Create + cancel one intent
 * 6. Create one expired intent and fail capture
 * 7. Create + release one escrow
 * 8. Print balances + audit
 */

import "dotenv/config";
import { generateKeyPairSync } from "crypto";
import fetch from "node-fetch";
import { ProxifyAgent, formatDollars } from "../sdk/agent";
import { performTask, type TaskOutput } from "./agentB";
import {
  createEscrowForAgentB,
  verifyTaskOutput,
  releaseEscrowToAgentB,
} from "./agentA";

const BASE = process.env.PROXIFY_BASE_URL ?? "http://localhost:3000";

function log(msg: string) {
  console.log(msg);
}

function section(title: string, subtitle?: string) {
  const line = "─".repeat(72);
  console.log("\n" + line);
  console.log(`▶ ${title}`);
  if (subtitle) console.log(`  ${subtitle}`);
  console.log(line + "\n");
}

async function postJson(path: string, body: object) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as Record<string, unknown>;
}

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as Record<string, unknown>;
}

function genKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function main() {
  section(
    "Proxify demo: full payment intent lifecycle + escrow",
    "Agent A hires Agent B. Proxify handles wallets, policy, payment intents, escrow, and audit."
  );

  section("1. Create org and controller");
  const orgRes = await postJson("/v1/orgs", { name: "Proxify Demo Org" });
  const orgId = orgRes.orgId as string;
  if (!orgId) throw new Error("Missing orgId");
  log(`Org created (orgId=${orgId})`);

  const ctrlRes = await postJson("/v1/controllers", {
    orgId,
    displayName: "Demo Controller",
  });
  const controllerId = ctrlRes.controllerId as string;
  if (!controllerId) throw new Error("Missing controllerId");
  log(`Controller created (controllerId=${controllerId})`);

  section("2. Register Agent A and Agent B");
  const keyA = genKeypair();
  const keyB = genKeypair();

  const regA = await postJson("/v1/agents/register", {
    orgId,
    controllerId,
    publicKeyPem: keyA.publicKeyPem,
  });
  const agentAId = regA.agentId as string;
  if (!agentAId) throw new Error("Missing agentAId");
  log(`Agent A registered (payer)  → agentId=${agentAId}`);

  const regB = await postJson("/v1/agents/register", {
    orgId,
    controllerId,
    publicKeyPem: keyB.publicKeyPem,
  });
  const agentBId = regB.agentId as string;
  if (!agentBId) throw new Error("Missing agentBId");
  log(`Agent B registered (worker) → agentId=${agentBId}`);

  const agentA = new ProxifyAgent({
    baseUrl: BASE,
    agentId: agentAId,
    privateKeyPem: keyA.privateKeyPem,
  });

  const agentB = new ProxifyAgent({
    baseUrl: BASE,
    agentId: agentBId,
    privateKeyPem: keyB.privateKeyPem,
  });

  section("3. Fund Agent A's wallet");
  const fundCents = 1500; // $15.00
  await postJson(`/v1/agents/${agentAId}/wallet/fund`, {
    amountCents: fundCents,
    note: "Demo funding for Agent A",
  });
  log(`Agent A funded with ${formatDollars(fundCents)}`);

  section("4. Set Agent A policy");
  await postJson(`/v1/agents/${agentAId}/policy`, { maxTxCents: 500 });
  log("Agent A policy set: max $5.00 per transfer/escrow/intent");

  const balanceAfterFund = await agentA.getBalance();
  log(`Agent A balance after funding: ${formatDollars(balanceAfterFund)}`);

  // ------------------------------------------------------------------
  // INTENT 1: CREATED -> CAPTURED
  // ------------------------------------------------------------------
  section(
    "5. Intent lifecycle demo #1 — create and capture",
    "Agent A creates a payment intent for Agent B, Agent B completes work, Agent A captures it."
  );

  const capturedIntent = await agentA.createIntent(
    agentBId,
    250,
    "Captured intent for first research task"
  );

  log(
    `Created intent ${capturedIntent.intent.id} for ${formatDollars(
      capturedIntent.intent.amountCents
    )} (status=${capturedIntent.intent.status})`
  );

  const taskOutput1: TaskOutput = performTask({
    taskType: "research",
    query: "What is Proxify?",
  });

  log("Agent B completed first task.");
  log(`  Result: ${taskOutput1.result.slice(0, 100)}${taskOutput1.result.length > 100 ? "..." : ""}`);
  log(`  Confidence: ${taskOutput1.confidence}`);

  const valid1 = verifyTaskOutput(taskOutput1);
  if (!valid1) throw new Error("Verification failed for captured intent task");

  const captureResult = await agentA.captureIntent(capturedIntent.intent.id);
  log(
    `Intent captured successfully. Agent A balance: ${formatDollars(
      captureResult.fromNewBalanceCents ?? 0
    )}, Agent B balance: ${formatDollars(captureResult.toNewBalanceCents ?? 0)}`
  );

  // ------------------------------------------------------------------
  // INTENT 2: CREATED -> CANCELLED
  // ------------------------------------------------------------------
  section(
    "6. Intent lifecycle demo #2 — create and cancel",
    "Agent A creates a second intent, then cancels it before capture."
  );

  const cancelledIntent = await agentA.createIntent(
    agentBId,
    180,
    "Cancelled intent for abandoned task"
  );

  log(
    `Created intent ${cancelledIntent.intent.id} for ${formatDollars(
      cancelledIntent.intent.amountCents
    )} (status=${cancelledIntent.intent.status})`
  );

  const cancelResult = await agentA.cancelIntent(cancelledIntent.intent.id);
  log(`Intent cancelled successfully → intentId=${cancelResult.intentId}, status=${cancelResult.status}`);

  // ------------------------------------------------------------------
  // INTENT 3: CREATED -> EXPIRED
  // ------------------------------------------------------------------
  section(
    "7. Intent lifecycle demo #3 — create, expire, and fail capture",
    "Agent A creates an already-expired intent and attempts to capture it."
  );

  const expiredIso = new Date(Date.now() - 60_000).toISOString(); // 1 minute in the past

  const expiredIntent = await agentA.createIntent(
    agentBId,
    160,
    "Expired intent for demo coverage",
    expiredIso
  );

  log(
    `Created expired intent ${expiredIntent.intent.id} with expiresAt=${expiredIso} (initial status=${expiredIntent.intent.status})`
  );

  try {
    await agentA.captureIntent(expiredIntent.intent.id);
    throw new Error("Expected expired intent capture to fail, but it succeeded");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Capture failed as expected for expired intent → ${msg}`);
  }

  const expiredIntentRow = await agentA.getIntent(expiredIntent.intent.id);
  log(`Expired intent final status in system: ${expiredIntentRow.status}`);

  // ------------------------------------------------------------------
  // ESCROW FLOW
  // ------------------------------------------------------------------
  section(
    "8. Escrow demo — create and release",
    "A second task uses escrow so funds are locked first, then released after verification."
  );

  const escrowCents = 300; // $3.00
  const { escrowId } = await createEscrowForAgentB(
    agentA,
    agentBId,
    escrowCents,
    "Payment for follow-up research task"
  );

  log(`Escrow created: ${escrowId} for ${formatDollars(escrowCents)}`);

  const taskOutput2: TaskOutput = performTask({
    taskType: "research",
    query: "How can Proxify support autonomous agent commerce?",
  });

  log("Agent B completed escrow-backed task.");
  log(`  Result: ${taskOutput2.result.slice(0, 100)}${taskOutput2.result.length > 100 ? "..." : ""}`);
  log(`  Confidence: ${taskOutput2.confidence}`);

  const valid2 = verifyTaskOutput(taskOutput2);
  if (!valid2) throw new Error("Verification failed for escrow task");

  await releaseEscrowToAgentB(agentA, escrowId);
  log("Escrow released to Agent B.");

  // ------------------------------------------------------------------
  // FINAL BALANCES
  // ------------------------------------------------------------------
  section("9. Final wallet balances");
  const balA = await agentA.getBalance();
  const balB = await agentB.getBalance();

  log(`Agent A (payer):  ${formatDollars(balA)}`);
  log(`Agent B (worker): ${formatDollars(balB)}`);

  // ------------------------------------------------------------------
  // AUDIT
  // ------------------------------------------------------------------
  section("10. Audit trail");
  const audit = await getJson(`/v1/audit?limit=25`);
  const events =
    (audit.events as Array<{ eventType: string; createdAt: string; amountCents?: number }>) ?? [];

  log("Recent audit events (latest first):");
  for (const e of events.slice(0, 20)) {
    const amt = e.amountCents != null ? ` (${formatDollars(e.amountCents)})` : "";
    log(`  ${e.createdAt}  ${e.eventType}${amt}`);
  }

  log(
    '\nOpen the dashboard at http://localhost:3000/dashboard to see agents, wallets, payment intents, escrows, and audit events in the browser.'
  );

  section("Demo complete");
  log(
    [
      "Summary:",
      "- Agent A created and captured one intent.",
      "- Agent A created and cancelled one intent.",
      "- Agent A created one expired intent and capture failed as expected.",
      "- Agent A created and released one escrow.",
      "- Proxify now demonstrates the full intent lifecycle plus escrow and audit logging.",
    ].join("\n")
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Demo failed:", msg);

  if (
    msg.includes("fetch") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("Connection refused")
  ) {
    console.error("\n→ Is the backend running? Start it with: npm run dev");
    console.error("→ Then run the demo again: npm run demo");
  }

  process.exit(1);
});