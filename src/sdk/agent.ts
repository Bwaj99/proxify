/**
 * Proxify SDK (Node >= 20). `ProxifyAgent` signs every request with the agent's
 * Ed25519 private key; `ProxifyAdmin` wraps the operator/provisioning API.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { HEADERS, buildMessage } from "../lib/canonical";

export interface AgentKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateAgentKeys(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export class ProxifyError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ProxifyError";
  }
}
/** @deprecated use ProxifyError */
export const ProxifyAgentError = ProxifyError;

export const formatDollars = (amountCents: number) => `$${(amountCents / 100).toFixed(2)}`;

export interface LedgerEntry {
  id: string;
  type: string;
  amountCents: number;
  counterpartyAgentId: string | null;
  escrowId: string | null;
  note: string | null;
  createdAt: string;
}
export interface EscrowInfo {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  note: string | null;
  status: "LOCKED" | "RELEASED" | "REFUNDED";
  createdAt: string;
  releasedAt: string | null;
}
export interface PaymentIntentInfo {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  note: string | null;
  status: "CREATED" | "CAPTURED" | "CANCELLED" | "EXPIRED";
  createdAt: string;
  capturedAt: string | null;
  expiresAt: string | null;
}
export interface AuditEvent {
  id: string;
  seq: number;
  eventType: string;
  orgId: string | null;
  agentId: string | null;
  actorAgentId: string | null;
  targetAgentId: string | null;
  amountCents: number | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
export interface TransferResult {
  success: true;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  fromNewBalanceCents: number;
  toNewBalanceCents: number;
  txOutId: string;
  txInId: string;
}
export interface CreateEscrowResult {
  success: true;
  escrowId: string;
  status: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  fromNewBalanceCents: number;
  txLockId: string;
}
export interface SettleEscrowResult {
  success: true;
  escrowId: string;
  status: "RELEASED" | "REFUNDED";
  toAgentId: string;
  toNewBalanceCents: number;
}

export interface ProxifyAgentConfig {
  baseUrl?: string;
  agentId: string;
  privateKeyPem: string;
  /** Extra attempts after a network failure or 5xx/429. Retries reuse the Idempotency-Key. Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProxifyAgent {
  private readonly baseUrl: string;
  readonly agentId: string;
  private readonly privateKeyPem: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ProxifyAgentConfig) {
    this.baseUrl = (config.baseUrl ?? "http://localhost:3000").trim().replace(/\/+$/, "");
    this.agentId = config.agentId;
    this.privateKeyPem = config.privateKeyPem;
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = config.fetch ?? fetch;
  }

  // ---- reads (signed: an agent can only read its own wallet/ledger/audit, and escrows/intents it is party to)
  getBalance() {
    return this.request<{ agentId: string; balanceCents: number; recentTransactions: LedgerEntry[] }>("GET", `/v1/agents/${this.agentId}/wallet`);
  }
  getLedger(opts: { limit?: number; before?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.before) q.set("before", opts.before);
    const qs = q.size ? `?${q}` : "";
    return this.request<{ transactions: LedgerEntry[]; nextBefore: string | null }>("GET", `/v1/agents/${this.agentId}/ledger${qs}`);
  }
  getPolicy() {
    return this.request<{ agentId: string; maxTxCents: number; dailyLimitCents: number | null; updatedAt: string }>("GET", `/v1/agents/${this.agentId}/policy`);
  }
  getAudit(limit = 50, cursor?: number) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) q.set("cursor", String(cursor));
    return this.request<{ count: number; events: AuditEvent[]; nextCursor: number | null }>("GET", `/v1/audit/agents/${this.agentId}?${q}`);
  }
  getEscrow(escrowId: string) {
    return this.request<EscrowInfo>("GET", `/v1/escrows/${escrowId}`);
  }
  getIntent(intentId: string) {
    return this.request<PaymentIntentInfo>("GET", `/v1/intents/${intentId}`);
  }

  // ---- writes. Each takes an optional idempotency key; pass your own to make a whole operation safe to retry across processes.
  transfer(toAgentId: string, amountCents: number, note?: string, idempotencyKey: string = randomUUID()) {
    return this.request<TransferResult>("POST", "/v1/tx/transfer", { toAgentId, amountCents, ...(note ? { note } : {}) }, idempotencyKey);
  }
  createEscrow(toAgentId: string, amountCents: number, note?: string, idempotencyKey: string = randomUUID()) {
    return this.request<CreateEscrowResult>("POST", "/v1/escrows", { toAgentId, amountCents, ...(note ? { note } : {}) }, idempotencyKey);
  }
  /** Payer only. */
  releaseEscrow(escrowId: string) {
    return this.request<SettleEscrowResult>("POST", `/v1/escrows/${escrowId}/release`, {});
  }
  /** Recipient (worker) only: hand the funds back to the payer. */
  refundEscrow(escrowId: string) {
    return this.request<SettleEscrowResult>("POST", `/v1/escrows/${escrowId}/refund`, {});
  }
  createIntent(toAgentId: string, amountCents: number, opts: { note?: string; expiresAt?: string; idempotencyKey?: string } = {}) {
    return this.request<{ success: true; intent: PaymentIntentInfo }>(
      "POST",
      "/v1/intents",
      { toAgentId, amountCents, ...(opts.note ? { note: opts.note } : {}), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) },
      opts.idempotencyKey ?? randomUUID(),
    );
  }
  captureIntent(intentId: string) {
    return this.request<TransferResult & { intentId: string }>("POST", `/v1/intents/${intentId}/capture`, {});
  }
  cancelIntent(intentId: string) {
    return this.request<{ success: true; intentId: string; status: string }>("POST", `/v1/intents/${intentId}/cancel`, {});
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: object, idempotencyKey?: string): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Fresh timestamp, nonce and signature on every attempt (the server rejects a reused nonce as a replay).
      // The Idempotency-Key stays constant, so a retry after a lost response cannot double-spend.
      const timestamp = String(Date.now());
      const nonce = randomBytes(16).toString("base64url");
      const signature = sign(
        null,
        Buffer.from(buildMessage({ agentId: this.agentId, timestamp, nonce, method, path, body: raw }), "utf8"),
        this.privateKeyPem,
      ).toString("base64");
      const headers: Record<string, string> = {
        [HEADERS.agentId]: this.agentId,
        [HEADERS.timestamp]: timestamp,
        [HEADERS.nonce]: nonce,
        [HEADERS.signature]: signature,
      };
      if (raw) headers["content-type"] = "application/json";
      if (idempotencyKey) headers[HEADERS.idempotencyKey] = idempotencyKey;

      // Non-idempotent writes (no key) must never be blindly retried.
      const retryable = method === "GET" || idempotencyKey !== undefined;
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: raw || undefined });
      } catch (err) {
        lastErr = err;
        if (!retryable || attempt === this.maxRetries) throw err;
        await sleep(100 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (res.ok) return json as T;
      if (retryable && (res.status >= 500 || res.status === 429) && attempt < this.maxRetries) {
        lastErr = new ProxifyError(json?.error ?? res.statusText, res.status, json?.code ?? "UNKNOWN", json);
        await sleep(100 * 2 ** attempt);
        continue;
      }
      throw new ProxifyError(json?.error ?? res.statusText, res.status, json?.code ?? "UNKNOWN", json);
    }
    throw lastErr;
  }
}

/** Operator client: provisioning, funding, policy, suspension, org audit, webhooks. */
export class ProxifyAdmin {
  private readonly baseUrl: string;
  constructor(
    baseUrl = "http://localhost:3000",
    private readonly adminToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  createOrg(name: string) {
    return this.call<{ orgId: string; name: string }>("POST", "/v1/orgs", { name });
  }
  createController(orgId: string, displayName: string) {
    return this.call<{ controllerId: string; orgId: string; displayName: string }>("POST", "/v1/controllers", { orgId, displayName });
  }
  registerAgent(o: { orgId: string; controllerId: string; publicKeyPem: string; maxTxCents?: number; dailyLimitCents?: number }) {
    return this.call<{ agentId: string; orgId: string; controllerId: string; status: string }>("POST", "/v1/agents/register", o);
  }
  setStatus(agentId: string, status: "ACTIVE" | "SUSPENDED") {
    return this.call<{ agentId: string; status: string }>("PATCH", `/v1/agents/${agentId}`, { status });
  }
  fund(agentId: string, amountCents: number, note?: string) {
    return this.call<{ success: true; agentId: string; newBalanceCents: number; txId: string }>("POST", `/v1/agents/${agentId}/wallet/fund`, { amountCents, ...(note ? { note } : {}) });
  }
  setPolicy(agentId: string, policy: { maxTxCents?: number; dailyLimitCents?: number | null }) {
    return this.call<{ success: true; agentId: string; maxTxCents: number; dailyLimitCents: number | null }>("POST", `/v1/agents/${agentId}/policy`, policy);
  }
  getWallet(agentId: string) {
    return this.call<{ agentId: string; balanceCents: number }>("GET", `/v1/agents/${agentId}/wallet`);
  }
  getAudit(q: { orgId?: string; agentId?: string; limit?: number; cursor?: number } = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.call<{ count: number; events: AuditEvent[]; nextCursor: number | null }>("GET", `/v1/audit?${p}`);
  }
  createWebhook(orgId: string, url: string) {
    return this.call<{ id: string; url: string; secret: string }>("POST", `/v1/orgs/${orgId}/webhooks`, { url });
  }
  getStats() {
    return this.call<Record<string, unknown>>("GET", "/v1/dashboard/stats");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.adminToken ? { [HEADERS.adminToken]: this.adminToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ProxifyError(json?.error ?? res.statusText, res.status, json?.code ?? "UNKNOWN", json);
    return json as T;
  }
}
