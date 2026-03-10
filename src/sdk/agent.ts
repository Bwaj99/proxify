/**
 * Proxify Agent SDK — lightweight client for autonomous agents.
 * Signs requests with Ed25519 using canonical message format.
 */

import { sign, randomUUID } from "crypto";
import { buildMessage } from "../auth";

const defaultBaseUrl = "http://localhost:3000";

export interface ProxifyAgentConfig {
  baseUrl?: string;
  agentId: string;
  privateKeyPem: string;
}

export interface WalletInfo {
  agentId: string;
  balanceCents: number;
  txCount?: number;
  transactions?: Array<{
    id: string;
    type: string;
    amountCents: number;
    note?: string | null;
  }>;
}

export interface PolicyInfo {
  agentId: string;
  maxTxCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface EscrowInfo {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  note: string | null;
  status: string;
  createdAt: string;
  releasedAt: string | null;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  orgId: string | null;
  agentId: string | null;
  actorAgentId: string | null;
  targetAgentId: string | null;
  amountCents: number | null;
  reason: string | null;
  createdAt: string;
}

export interface AuditResponse {
  count: number;
  events: AuditEvent[];
}

export interface TransferResult {
  success: boolean;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  fromNewBalanceCents: number | null;
  toNewBalanceCents: number | null;
  txOutId: string;
  txInId: string;
}

export interface CreateEscrowResult {
  success: boolean;
  escrowId: string;
  status: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  fromNewBalanceCents: number | null;
  txLockId: string;
}

export interface ReleaseEscrowResult {
  success: boolean;
  escrowId: string;
  status: string;
  releasedByAgentId: string;
  toAgentId: string;
  toNewBalanceCents: number | null;
  txReleaseId: string;
}

export interface PaymentIntentInfo {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  note: string | null;
  status: string;
  createdAt: string;
  capturedAt: string | null;
  expiresAt: string | null;
}

export interface CreateIntentResult {
  success: boolean;
  intent: {
    id: string;
    fromAgentId: string;
    toAgentId: string;
    amountCents: number;
    note: string | null;
    status: string;
    expiresAt: string | null;
  };
}

export interface CaptureIntentResult {
  success: boolean;
  intentId: string;
  status: string;
  fromAgentId: string;
  toAgentId: string;
  amountCents: number;
  fromNewBalanceCents: number | null;
  toNewBalanceCents: number | null;
  txOutId: string;
  txInId: string;
}

export interface CancelIntentResult {
  success: boolean;
  intentId: string;
  status: string;
}

export class ProxifyAgentError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "ProxifyAgentError";
  }
}

function ensureBaseUrl(baseUrl: string): string {
  const u = baseUrl.trim();
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/** Convenience helper for demos: cents -> "$0.00" string. */
export function formatDollars(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

export class ProxifyAgent {
  private readonly baseUrl: string;
  readonly agentId: string;
  private readonly privateKeyPem: string;

  constructor(config: ProxifyAgentConfig) {
    this.baseUrl = ensureBaseUrl(config.baseUrl ?? defaultBaseUrl);
    this.agentId = config.agentId;
    this.privateKeyPem = config.privateKeyPem;
  }

  private async request<T>(params: {
    method: "GET" | "POST";
    path: string;
    body?: object;
    signed?: boolean;
    idempotencyKey?: string;
  }): Promise<{ status: number; data: T }> {
    const url = `${this.baseUrl}${params.path}`;
    const bodyRaw = params.body !== undefined ? JSON.stringify(params.body) : "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (params.signed) {
      const timestamp = Date.now().toString();
      const nonce = randomUUID();
      const message = buildMessage(
        this.agentId,
        timestamp,
        nonce,
        params.method,
        params.path,
        bodyRaw
      );
      const signatureB64 = sign(
        null,
        Buffer.from(message, "utf8"),
        this.privateKeyPem
      ).toString("base64");

      headers["X-Agent-Id"] = this.agentId;
      headers["X-Timestamp"] = timestamp;
      headers["X-Nonce"] = nonce;
      headers["X-Signature"] = signatureB64;
    }

    if (params.idempotencyKey) {
      headers["Idempotency-Key"] = params.idempotencyKey;
    }

    const res = await fetch(url, {
      method: params.method,
      headers,
      ...(params.method === "POST" && bodyRaw !== "" && { body: bodyRaw }),
    });

    const contentType = res.headers.get("content-type") || "";
    let parsedBody: unknown = null;
    let rawBody: string | null = null;

    try {
      rawBody = await res.text();
      if (contentType.includes("application/json") && rawBody) {
        parsedBody = JSON.parse(rawBody) as T;
      } else if (rawBody) {
        parsedBody = rawBody as unknown as T;
      }
    } catch {
      // ignore parse failures
    }

    if (!res.ok) {
      const bodyForError = parsedBody ?? rawBody;
      const errorMessageFromBody =
        bodyForError &&
        typeof bodyForError === "object" &&
        "error" in (bodyForError as Record<string, unknown>)
          ? (bodyForError as { error?: unknown }).error
          : undefined;

      const message =
        (typeof errorMessageFromBody === "string" && errorMessageFromBody) ||
        res.statusText ||
        "Request failed";

      throw new ProxifyAgentError(message, res.status, bodyForError);
    }

    return { status: res.status, data: (parsedBody ?? ({} as T)) as T };
  }

  /** Get wallet balance only. */
  async getBalance(): Promise<number> {
    const { data } = await this.request<{ balanceCents: number }>({
      method: "GET",
      path: `/v1/agents/${this.agentId}/wallet`,
    });
    return data.balanceCents;
  }

  /** Get full wallet info. */
  async getWallet(): Promise<WalletInfo> {
    const { data } = await this.request<WalletInfo>({
      method: "GET",
      path: `/v1/agents/${this.agentId}/wallet`,
    });
    return data;
  }

  /** Get agent policy. */
  async getPolicy(): Promise<PolicyInfo> {
    const { data } = await this.request<PolicyInfo>({
      method: "GET",
      path: `/v1/agents/${this.agentId}/policy`,
    });
    return data;
  }

  /** Transfer to another agent (signed + idempotent). */
  async transfer(
    toAgentId: string,
    amountCents: number,
    note?: string,
    idempotencyKey?: string
  ): Promise<TransferResult> {
    const key = idempotencyKey ?? randomUUID();
    const { data } = await this.request<TransferResult>({
      method: "POST",
      path: "/v1/tx/transfer",
      body: { toAgentId, amountCents, note },
      signed: true,
      idempotencyKey: key,
    });
    return data;
  }

  /** Create escrow to another agent (signed). */
  async createEscrow(
    toAgentId: string,
    amountCents: number,
    note?: string
  ): Promise<{ escrowId: string; status: string; fromNewBalanceCents: number | null }> {
    const { data } = await this.request<CreateEscrowResult>({
      method: "POST",
      path: "/v1/escrows",
      body: { toAgentId, amountCents, note },
      signed: true,
    });
    return {
      escrowId: data.escrowId,
      status: data.status,
      fromNewBalanceCents: data.fromNewBalanceCents,
    };
  }

  /** Release escrow (payer only, signed). */
  async releaseEscrow(
    escrowId: string
  ): Promise<{ success: boolean; status: string; toNewBalanceCents: number | null }> {
    const { data } = await this.request<ReleaseEscrowResult>({
      method: "POST",
      path: `/v1/escrows/${escrowId}/release`,
      body: {},
      signed: true,
    });
    return {
      success: data.success,
      status: data.status,
      toNewBalanceCents: data.toNewBalanceCents,
    };
  }

  /** Get escrow by id. */
  async getEscrow(escrowId: string): Promise<EscrowInfo> {
    const { data } = await this.request<EscrowInfo>({
      method: "GET",
      path: `/v1/escrows/${escrowId}`,
    });
    return data;
  }

  /** Get recent audit events for this agent. */
  async getAudit(limit?: number): Promise<AuditResponse> {
    const q = limit != null ? `?limit=${Math.min(limit, 1000)}` : "";
    const { data } = await this.request<AuditResponse>({
      method: "GET",
      path: `/v1/audit/agents/${this.agentId}${q}`,
    });
    return data;
  }

  /** Get global audit (useful for dashboards). */
  async getAuditGlobal(limit?: number): Promise<AuditResponse> {
    const q = limit != null ? `?limit=${Math.min(limit, 1000)}` : "?limit=100";
    const { data } = await this.request<AuditResponse>({
      method: "GET",
      path: `/v1/audit${q}`,
    });
    return data;
  }

  /** Create payment intent (signed). */
  async createIntent(
    toAgentId: string,
    amountCents: number,
    note?: string,
    expiresAt?: string
  ): Promise<CreateIntentResult> {
    const { data } = await this.request<CreateIntentResult>({
      method: "POST",
      path: "/v1/intents",
      body: { toAgentId, amountCents, note, expiresAt },
      signed: true,
    });
    return data;
  }

  /** Get payment intent by id. */
  async getIntent(intentId: string): Promise<PaymentIntentInfo> {
    const { data } = await this.request<PaymentIntentInfo>({
      method: "GET",
      path: `/v1/intents/${intentId}`,
    });
    return data;
  }

  /** Capture payment intent (signed, payer-only). */
  async captureIntent(intentId: string): Promise<CaptureIntentResult> {
    const { data } = await this.request<CaptureIntentResult>({
      method: "POST",
      path: `/v1/intents/${intentId}/capture`,
      body: {},
      signed: true,
    });
    return data;
  }

  /** Cancel payment intent (signed, payer-only). */
  async cancelIntent(intentId: string): Promise<CancelIntentResult> {
    const { data } = await this.request<CancelIntentResult>({
      method: "POST",
      path: `/v1/intents/${intentId}/cancel`,
      body: {},
      signed: true,
    });
    return data;
  }
}