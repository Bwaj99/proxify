import { timingSafeEqual, verify } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { agents, nonces } from "../db/schema";
import { HEADERS, buildMessage } from "../lib/canonical";
import { forbidden, unauthorized } from "../lib/errors";
import type { Actor } from "../services/payments";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: string;
      agent?: Actor;
      requestId?: string;
    }
  }
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** True only when an admin token is configured AND presented (header, or HTTP Basic password for browsers). */
export function hasAdminCredentials(req: Request, config: Config): boolean {
  if (!config.adminToken) return false;
  const header = req.header(HEADERS.adminToken);
  if (header && safeEqual(header, config.adminToken)) return true;
  const auth = req.header("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(pass, config.adminToken)) return true;
  }
  return false;
}

/**
 * Admin-only routes. With no ADMIN_TOKEN configured they're open outside
 * production (local demo convenience); production config validation makes the
 * token mandatory. `basicChallenge` makes browsers prompt for the token.
 */
export function requireAdmin(config: Config, opts: { basicChallenge?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    if (hasAdminCredentials(req, config)) return next();
    if (!config.adminToken && config.env !== "production") return next();
    if (opts.basicChallenge) res.set("WWW-Authenticate", 'Basic realm="Proxify admin"');
    throw unauthorized("Admin credentials required", "ADMIN_REQUIRED");
  };
}

/**
 * Verification order is deliberate: cheapest and least state-mutating first.
 *  1 headers well-formed   2 timestamp inside window   3 agent exists and is ACTIVE
 *  4 Ed25519 signature over the canonical string       5 nonce consumed (INSERT)
 * The nonce is only recorded after the signature is valid, so unauthenticated
 * callers can never fill the nonce table or burn a victim's nonces.
 */
export function requireSignature(db: Db, config: Config): RequestHandler {
  let requests = 0;
  return async (req: Request, _res: Response, next: NextFunction) => {
    const agentId = req.header(HEADERS.agentId);
    const timestamp = req.header(HEADERS.timestamp);
    const nonce = req.header(HEADERS.nonce);
    const signature = req.header(HEADERS.signature);
    if (!agentId || !timestamp || !nonce || !signature) {
      throw unauthorized("Missing one of X-Agent-Id, X-Timestamp, X-Nonce, X-Signature", "MISSING_AUTH_HEADERS");
    }
    if (!UUID_RE.test(agentId)) throw unauthorized("Malformed X-Agent-Id", "INVALID_AGENT");
    if (!NONCE_RE.test(nonce)) throw unauthorized("X-Nonce must be 16-128 chars of [A-Za-z0-9_-]", "INVALID_NONCE");

    const ts = Number(timestamp);
    if (!Number.isInteger(ts) || Math.abs(Date.now() - ts) > config.signatureWindowMs) {
      throw unauthorized("Timestamp outside the accepted window", "STALE_TIMESTAMP");
    }

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw unauthorized("Unknown agent", "INVALID_AGENT");

    const message = buildMessage({
      agentId,
      timestamp,
      nonce,
      method: req.method,
      path: req.originalUrl,
      body: req.rawBody ?? "",
    });
    let valid = false;
    try {
      valid = verify(null, Buffer.from(message, "utf8"), agent.publicKeyPem, Buffer.from(signature, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) throw unauthorized("Invalid signature", "INVALID_SIGNATURE");
    if (agent.status !== "ACTIVE") throw forbidden("Agent is suspended", "AGENT_SUSPENDED");

    const fresh = await db.insert(nonces).values({ agentId, nonce }).onConflictDoNothing().returning({ n: nonces.nonce });
    if (fresh.length === 0) throw unauthorized("Replay detected (nonce already used)", "REPLAYED_NONCE");

    // Older than the window can't be replayed anyway (timestamp check), so it's safe to drop.
    if (++requests % 100 === 0) {
      void db
        .delete(nonces)
        .where(lt(nonces.seenAt, new Date(Date.now() - config.signatureWindowMs * 2)))
        .catch(() => {});
    }

    req.agent = { id: agent.id, orgId: agent.orgId, controllerId: agent.controllerId };
    next();
  };
}

/** Route reads an agent's own resources: that agent (signed) or an admin. */
export function requireSelfOrAdmin(db: Db, config: Config, param = "agentId"): RequestHandler {
  const signed = requireSignature(db, config);
  return async (req, res, next) => {
    if (hasAdminCredentials(req, config)) return next();
    await signed(req, res, () => {});
    if (req.agent!.id !== req.params[param]) throw forbidden("You can only access your own resources", "NOT_OWNER");
    next();
  };
}
