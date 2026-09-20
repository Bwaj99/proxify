import { createHmac, randomBytes } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { orgs, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { badRequest, notFound } from "../lib/errors";

export const SIGNATURE_HEADER = "x-proxify-signature";

/** `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. Receivers should also reject stale `t`. */
export function signWebhook(secret: string, body: string, timestampSec: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

function assertWebhookUrl(raw: string, config: Pick<Config, "allowInsecureWebhooks">): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("url is not a valid URL", "INVALID_WEBHOOK_URL");
  }
  if (u.protocol !== "https:" && !(config.allowInsecureWebhooks && u.protocol === "http:")) {
    throw badRequest("Webhook URLs must use https", "INVALID_WEBHOOK_URL");
  }
  if (u.username || u.password) throw badRequest("Webhook URLs must not embed credentials", "INVALID_WEBHOOK_URL");
}

export async function createEndpoint(db: Db, config: Pick<Config, "allowInsecureWebhooks">, orgId: string, url: string) {
  assertWebhookUrl(url, config);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw notFound("Org not found", "ORG_NOT_FOUND");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const [ep] = await db.insert(webhookEndpoints).values({ orgId, url, secret }).returning();
  // The secret is returned exactly once.
  return { id: ep!.id, orgId, url, active: true, secret, createdAt: ep!.createdAt };
}

export async function listEndpoints(db: Db, orgId: string) {
  return db
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, active: webhookEndpoints.active, createdAt: webhookEndpoints.createdAt })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.orgId, orgId));
}

export async function deactivateEndpoint(db: Db, orgId: string, endpointId: string) {
  const rows = await db
    .update(webhookEndpoints)
    .set({ active: false })
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.orgId, orgId)))
    .returning({ id: webhookEndpoints.id });
  if (rows.length === 0) throw notFound("Webhook endpoint not found", "WEBHOOK_NOT_FOUND");
}

const LEASE_MS = 60_000;
const backoffMs = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 60 * 60 * 1000);

/**
 * Claims due deliveries with FOR UPDATE SKIP LOCKED (safe with several
 * workers/instances), pushes their next attempt forward as a lease, then
 * delivers outside the transaction. Returns how many were attempted.
 */
export async function deliverDue(
  db: Db,
  config: Pick<Config, "webhookMaxAttempts">,
  fetchImpl: typeof fetch = fetch,
  batchSize = 20,
): Promise<number> {
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, "PENDING"), lte(webhookDeliveries.nextAttemptAt, new Date())))
      .orderBy(webhookDeliveries.nextAttemptAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + LEASE_MS) })
      .where(inArray(webhookDeliveries.id, due.map((d) => d.id)));
    return due;
  });
  if (claimed.length === 0) return 0;

  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(inArray(webhookEndpoints.id, [...new Set(claimed.map((d) => d.endpointId))]));
  const byId = new Map(endpoints.map((e) => [e.id, e]));

  await Promise.all(
    claimed.map(async (d) => {
      const ep = byId.get(d.endpointId);
      const attempts = d.attempts + 1;
      let error: string | null = null;
      if (!ep || !ep.active) {
        error = "endpoint inactive";
      } else {
        const body = JSON.stringify(d.payload);
        try {
          const res = await fetchImpl(ep.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "Proxify-Webhooks/1",
              "x-proxify-event-id": d.auditEventId,
              [SIGNATURE_HEADER]: signWebhook(ep.secret, body, Math.floor(Date.now() / 1000)),
            },
            body,
            signal: AbortSignal.timeout(5_000),
            redirect: "error", // never follow redirects (SSRF hygiene)
          });
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      if (error === null) {
        await db
          .update(webhookDeliveries)
          .set({ status: "DELIVERED", attempts, deliveredAt: new Date(), lastError: null })
          .where(eq(webhookDeliveries.id, d.id));
      } else {
        const dead = attempts >= config.webhookMaxAttempts || !ep || !ep.active;
        await db
          .update(webhookDeliveries)
          .set({
            status: dead ? "FAILED" : "PENDING",
            attempts,
            lastError: error,
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          })
          .where(eq(webhookDeliveries.id, d.id));
      }
    }),
  );
  return claimed.length;
}

/** Simple polling loop. Returns a stop function that waits for the in-flight batch. */
export function startWebhookWorker(db: Db, config: Config): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = deliverDue(db, config)
      .catch((e) => console.error("webhook worker error:", e))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, config.webhookPollMs);
      });
  };
  let timer = setTimeout(tick, config.webhookPollMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

export async function deliveryStats(db: Db) {
  const rows = await db
    .select({ status: webhookDeliveries.status, n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .groupBy(webhookDeliveries.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
