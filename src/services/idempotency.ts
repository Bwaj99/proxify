import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { AppError } from "../lib/errors";

export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * Runs `fn` at most once per (agent, key).
 *
 * The key row is claimed FIRST, inside the same transaction as the business
 * logic:
 *  - concurrent duplicates block on the primary key until the first commits,
 *    then replay its stored response (no double spend);
 *  - if `fn` throws, everything - including the key - rolls back, so a retry
 *    after e.g. insufficient funds is a genuine new attempt;
 *  - reusing a key for a *different* request is rejected (422), never replayed.
 */
export async function withIdempotency(
  db: Db & { transaction: Db["transaction"] },
  agentId: string,
  key: string,
  endpoint: string,
  fingerprint: string,
  fn: (tx: Db) => Promise<HandlerResult>,
): Promise<HandlerResult & { replayed: boolean }> {
  const requestHash = createHash("sha256").update(`${endpoint}\n${fingerprint}`).digest("hex");
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ agentId, key, endpoint, requestHash, responseStatus: 0, responseJson: {} })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (claimed.length === 0) {
      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.agentId, agentId), eq(idempotencyKeys.key, key)));
      if (!existing) throw new AppError(500, "INTERNAL", "Idempotency record vanished");
      if (existing.requestHash !== requestHash) {
        throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
      }
      return { status: existing.responseStatus, body: existing.responseJson, replayed: true };
    }

    const result = await fn(tx);
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: result.status, responseJson: result.body as object })
      .where(and(eq(idempotencyKeys.agentId, agentId), eq(idempotencyKeys.key, key)));
    return { ...result, replayed: false };
  });
}
