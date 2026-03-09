/**
 * Proxify demo — agent-to-agent economic coordination.
 * Run: npx ts-node src/demo/runDemo.ts (or npm run demo)
 *
 * Flow: Register A & B → Fund A → Set policy → A creates escrow for B →
 * B completes task → A verifies → A releases escrow → Balances & audit.
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
  const line = "─".repeat(70);
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
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as Record<string, unknown>;
}

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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
    "Proxify demo: autonomous agent-to-agent payment",
    "Agent A hires Agent B for a research task. Proxify handles wallets, policy, escrow, and audit."
  );

  section("1. Create org and controller", "Set up an organization and controller that own the agents.");
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

  section(
    "2. Register Agent A and Agent B",
    "Agent A is the payer/hirer. Agent B is the worker that completes tasks and gets paid."
  );
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

  section(
    "3. Fund Agent A's wallet",
    "Seed Agent A with demo credits so it can pay other agents."
  );
  const fundCents = 1000; // $10.00
  await postJson(`/v1/agents/${agentAId}/wallet/fund`, {
    amountCents: fundCents,
    note: "Demo funding for Agent A",
  });
  log(`Agent A funded with ${formatDollars(fundCents)}`);

  section(
    "4. Set Agent A policy",
    "Limit how much Agent A can move per transfer / escrow (risk controls)."
  );
  await postJson(`/v1/agents/${agentAId}/policy`, { maxTxCents: 500 });
  log("Agent A policy set: max $5.00 per transfer/escrow\n");

  const agentA = new ProxifyAgent({
    baseUrl: BASE,
    agentId: agentAId,
    privateKeyPem: keyA.privateKeyPem,
  });

  const balanceAfterFund = await agentA.getBalance();
  log(`Agent A balance after funding: ${formatDollars(balanceAfterFund)}\n`);

  section(
    "5. Agent A opens an escrow for Agent B",
    "Agent A locks funds in escrow before Agent B starts working."
  );
  const escrowCents = 300; // $3.00
  const { escrowId } = await createEscrowForAgentB(
    agentA,
    agentBId,
    escrowCents,
    "Payment for research task"
  );
  log(
    `Agent A created escrow for Agent B: ${formatDollars(
      escrowCents
    )} locked for "Payment for research task".`
  );

  section(
    "6. Agent B completes the task",
    "Agent B performs a deterministic 'research' task so the demo output is stable."
  );
  const taskOutput: TaskOutput = performTask({
    taskType: "research",
    query: "What is Proxify?",
  });
  log("Agent B completed task.");
  log(`  Task type: ${taskOutput.taskType}`);
  log(`  Query:     "${taskOutput.query}"`);
  log(`  Result:    ${taskOutput.result.slice(0, 100)}${taskOutput.result.length > 100 ? "..." : ""}`);
  log(`  Confidence:${taskOutput.confidence}\n`);

  section(
    "7. Agent A verifies the work",
    "In this prototype, verification is a simple confidence + non-empty-result check."
  );
  const valid = verifyTaskOutput(taskOutput);
  if (!valid) throw new Error("Agent A verification failed");
  log("Agent A is satisfied with the result and approves payment.\n");

  section(
    "8. Agent A releases escrow",
    "A signed, payer-only call releases funds from escrow into Agent B's wallet."
  );
  await releaseEscrowToAgentB(agentA, escrowId);
  log("Escrow released to Agent B.\n");

  section("9. Final wallet balances", "See how funds moved between Agent A and Agent B.");
  const balA = await agentA.getBalance();
  const agentB = new ProxifyAgent({
    baseUrl: BASE,
    agentId: agentBId,
    privateKeyPem: keyB.privateKeyPem,
  });
  const balB = await agentB.getBalance();

  log("Final balances after escrow release:");
  log(`  Agent A (payer):  ${formatDollars(balA)}`);
  log(`  Agent B (worker): ${formatDollars(balB)}\n`);

  section("10. Audit trail", "Every value-moving action is written to the audit log.");
  const audit = await getJson(`/v1/audit?limit=15`);
  const events = (audit.events as Array<{ eventType: string; createdAt: string; amountCents?: number }>) ?? [];
  log("Recent audit events (latest first):");
  for (const e of events.slice(0, 12)) {
    const amt = e.amountCents != null ? ` (${formatDollars(e.amountCents)})` : "";
    log(`  ${e.createdAt}  ${e.eventType}${amt}`);
  }

  log(
    '\nOpen the dashboard at http://localhost:3000/dashboard to see agents, wallets, escrows, and audit events in the browser.'
  );

  section("Demo complete", "Autonomous agents coordinated a paid task end-to-end using Proxify.");
  log(
    [
      "Summary:",
      "- Agent A (payer) funded its wallet and set a spending policy.",
      "- Agent A opened an escrow to Agent B for a research task.",
      "- Agent B (worker) completed the task with deterministic output.",
      "- Agent A verified the result and released the escrow.",
      "- Proxify enforced policy, ensured signed requests, and recorded an auditable trail.",
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
    console.error(`→ Then run the demo again: npm run demo`);
  }
  process.exit(1);
});
