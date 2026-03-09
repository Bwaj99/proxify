/**
 * Agent A — payer / hirer.
 * In the demo, Agent A is the "hiring" agent that opens an escrow,
 * checks Agent B's work, and then releases payment.
 */

import type { ProxifyAgent } from "../sdk/agent";
import type { TaskOutput } from "./agentB";

/**
 * Creates an escrow from Agent A to Agent B for a given task payment.
 */
export async function createEscrowForAgentB(
  agentA: ProxifyAgent,
  agentBId: string,
  amountCents: number,
  note?: string
): Promise<{ escrowId: string; fromNewBalanceCents: number }> {
  const result = await agentA.createEscrow(agentBId, amountCents, note);
  return { escrowId: result.escrowId, fromNewBalanceCents: result.fromNewBalanceCents };
}

/**
 * Simple, deterministic verification rule for Agent B's task output.
 */
export function verifyTaskOutput(output: TaskOutput): boolean {
  return (
    typeof output.result === "string" &&
    output.result.length > 0 &&
    typeof output.confidence === "number" &&
    output.confidence >= 0.5
  );
}

/**
 * Releases escrow to Agent B once Agent A is satisfied with the work.
 */
export async function releaseEscrowToAgentB(
  agentA: ProxifyAgent,
  escrowId: string
): Promise<{ toNewBalanceCents: number }> {
  const result = await agentA.releaseEscrow(escrowId);
  return { toNewBalanceCents: result.toNewBalanceCents };
}
