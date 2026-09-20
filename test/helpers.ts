import { randomBytes, sign } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createDb, type DbHandle } from "../src/db/client";
import { HEADERS, buildMessage } from "../src/lib/canonical";
import { ProxifyAdmin, ProxifyAgent, ProxifyError, generateAgentKeys, type AgentKeyPair } from "../src/sdk/agent";

export const ADMIN_TOKEN = "test-admin-token-0123456789";

export interface TestEnv {
  handle: DbHandle;
  config: Config;
  server: Server;
  baseUrl: string;
  admin: ProxifyAdmin;
  orgId: string;
  controllerId: string;
  close(): Promise<void>;
}

export interface TestAgent {
  id: string;
  orgId: string;
  keys: AgentKeyPair;
  client: ProxifyAgent;
}

/**
 * Boots the real app on an ephemeral port. Uses TEST_DATABASE_URL (real
 * PostgreSQL, as in CI) when set, otherwise embedded PGlite. Every test builds
 * its own org/agents, so no cleanup between tests is needed.
 */
export async function startEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const config: Config = {
    ...loadConfig({ NODE_ENV: "test", ADMIN_TOKEN, ALLOW_INSECURE_WEBHOOKS: "true" }),
    rateLimitPerMin: 0,
    ...overrides,
  };
  const handle = await createDb({ databaseUrl: process.env.TEST_DATABASE_URL });
  const server = createApp(handle.db, config).listen(0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = new ProxifyAdmin(baseUrl, ADMIN_TOKEN);
  const { orgId } = await admin.createOrg("Test Org");
  const { controllerId } = await admin.createController(orgId, "ctl");
  return {
    handle,
    config,
    server,
    baseUrl,
    admin,
    orgId,
    controllerId,
    close: async () => {
      await new Promise((r) => server.close(r));
      await handle.close();
    },
  };
}

export async function newAgent(env: TestEnv, opts: { fund?: number; maxTxCents?: number; dailyLimitCents?: number } = {}): Promise<TestAgent> {
  const keys = generateAgentKeys();
  const a = await env.admin.registerAgent({
    orgId: env.orgId,
    controllerId: env.controllerId,
    publicKeyPem: keys.publicKeyPem,
    ...(opts.maxTxCents ? { maxTxCents: opts.maxTxCents } : {}),
    ...(opts.dailyLimitCents ? { dailyLimitCents: opts.dailyLimitCents } : {}),
  });
  if (opts.fund) await env.admin.fund(a.agentId, opts.fund);
  return {
    id: a.agentId,
    orgId: env.orgId,
    keys,
    client: new ProxifyAgent({ baseUrl: env.baseUrl, agentId: a.agentId, privateKeyPem: keys.privateKeyPem, maxRetries: 0 }),
  };
}

/** Hand-built signed request so tests can tamper with or replay exact bytes. */
export function rawSigned(
  agent: TestAgent,
  method: string,
  path: string,
  body = "",
  over: { timestamp?: string; nonce?: string; idem?: string } = {},
) {
  const timestamp = over.timestamp ?? String(Date.now());
  const nonce = over.nonce ?? randomBytes(16).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(buildMessage({ agentId: agent.id, timestamp, nonce, method, path, body }), "utf8"),
    agent.keys.privateKeyPem,
  ).toString("base64");
  return {
    method,
    headers: {
      "content-type": "application/json",
      [HEADERS.agentId]: agent.id,
      [HEADERS.timestamp]: timestamp,
      [HEADERS.nonce]: nonce,
      [HEADERS.signature]: signature,
      ...(over.idem ? { [HEADERS.idempotencyKey]: over.idem } : {}),
    } as Record<string, string>,
    body: body || undefined,
  };
}

export async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProxifyError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

export const balance = async (a: TestAgent) => (await a.client.getBalance()).balanceCents;
