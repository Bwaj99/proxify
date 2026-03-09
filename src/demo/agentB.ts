/**
 * Agent B — worker agent.
 * In the demo, Agent B is the "worker" agent that completes a task
 * (like research or classification) and gets paid via escrow.
 */

export interface TaskInput {
  taskType: "research" | "classification";
  query: string;
}

export interface TaskOutput {
  taskType: string;
  query: string;
  result: string;
  confidence: number;
  completedAt: string;
}

/**
 * Simulates Agent B completing a task (e.g. research or classification).
 * The behavior is deterministic so the demo output is stable.
 */
export function performTask(input: TaskInput): TaskOutput {
  const completedAt = new Date().toISOString();

  if (input.taskType === "classification") {
    return {
      taskType: "classification",
      query: input.query,
      result: "positive",
      confidence: 0.95,
      completedAt,
    };
  }

  // research
  return {
    taskType: "research",
    query: input.query,
    result: `Short research summary for "${input.query}": Proxify provides financial infrastructure for autonomous agents — wallets, policies, escrow, signed transfers, and an audit trail.`,
    confidence: 0.92,
    completedAt,
  };
}
