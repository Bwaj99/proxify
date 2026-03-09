import fetch from "node-fetch";
import { generateKeyPairSync, sign, randomUUID } from "crypto";

const BASE = "http://localhost:3000";

function buildMessage(
  agentId: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: string
) {
  return `${agentId}.${timestamp}.${nonce}.${method}.${path}.${body}`;
}

type Keypair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

function genEd25519Keypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKeyPem, privateKeyPem };
}

async function postJson(url: string, body: any) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  return { status: resp.status, data };
}

async function getJson(url: string) {
  const resp = await fetch(url);
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

/**
 * Signed POST helper
 * - signs canonical message = buildMessage(agentId, ts, nonce, method, path, bodyRaw)
 * - sends headers: X-Agent-Id, X-Timestamp, X-Nonce, X-Signature
 */
async function postSignedJson(params: {
  agentId: string;
  privateKeyPem: string;
  path: string; // must be EXACT server route path, e.g. "/v1/tx/transfer"
  body: any; // will be JSON.stringify'd
}) {
  const bodyRaw = JSON.stringify(params.body);
  const ts = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2);
  const idemKey = randomUUID();

  const msg = buildMessage(params.agentId, ts, nonce, "POST", params.path, bodyRaw);
  const sigB64 = sign(null, Buffer.from(msg, "utf8"), params.privateKeyPem).toString("base64");

  const resp = await fetch(`${BASE}${params.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Id": params.agentId,
      "X-Timestamp": ts,
      "X-Nonce": nonce,
      "X-Signature": sigB64,
      "Idempotency-Key": idemKey,
    },
    body: bodyRaw,
  });

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  return { status: resp.status, data };
}

/**
 * Signed POST helper (NO X-Agent-Id header)
 * Used for /v1/agents/:agentId/protected which authenticates via the agentId in URL + signature headers.
 */
async function postSignedProtected(params: {
  agentId: string;
  privateKeyPem: string;
  path: string; // e.g. `/v1/agents/${agentId}/protected`
  body: any;
}) {
  const bodyRaw = JSON.stringify(params.body);
  const ts = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2);

  const msg = buildMessage(params.agentId, ts, nonce, "POST", params.path, bodyRaw);
  const sigB64 = sign(null, Buffer.from(msg, "utf8"), params.privateKeyPem).toString("base64");

  const resp = await fetch(`${BASE}${params.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": ts,
      "X-Nonce": nonce,
      "X-Signature": sigB64,
    },
    body: bodyRaw,
  });

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  return { status: resp.status, data, ts, nonce, sigB64, bodyRaw };
}

function print(label: string, payload: any) {
  console.log(`${label}:`, payload);
}

(async () => {
  // 1) Create org
  const orgResp = await postJson(`${BASE}/v1/orgs`, { name: "Demo Org" });
  print("Org response", orgResp);

  const orgId = orgResp.data?.orgId;
  if (!orgId) throw new Error("orgId missing from /v1/orgs response");

  // 2) Create controller
  const controllerResp = await postJson(`${BASE}/v1/controllers`, {
    orgId,
    displayName: "Bharadwaj",
  });
  print("Controller response", controllerResp);

  const controllerId = controllerResp.data?.controllerId;
  if (!controllerId) throw new Error("controllerId missing from /v1/controllers response");

  // 3) Generate keypairs for Agent A and Agent B
  const agentAKeys = genEd25519Keypair();
  const agentBKeys = genEd25519Keypair();

  // 4) Register Agent A
  const regA = await postJson(`${BASE}/v1/agents/register`, {
    orgId,
    controllerId,
    publicKeyPem: agentAKeys.publicKeyPem,
  });
  print("Register response (Agent A)", regA);

  const agentAId = regA.data?.agentId;
  if (!agentAId) throw new Error("agentId missing from Agent A register response");

  // 5) Register Agent B
  const regB = await postJson(`${BASE}/v1/agents/register`, {
    orgId,
    controllerId,
    publicKeyPem: agentBKeys.publicKeyPem,
  });
  print("Register response (Agent B)", regB);

  const agentBId = regB.data?.agentId;
  if (!agentBId) throw new Error("agentId missing from Agent B register response");

  // 6) Protected call (signed) + replay test
  const protectedPath = `/v1/agents/${agentAId}/protected`;
  const protected1 = await postSignedProtected({
    agentId: agentAId,
    privateKeyPem: agentAKeys.privateKeyPem,
    path: protectedPath,
    body: { amount: 5 },
  });
  print("Protected response #1", protected1.data);

  // Replay exact same request (same ts/nonce/signature/body) — should fail
  const replayResp = await fetch(`${BASE}${protectedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": protected1.ts,
      "X-Nonce": protected1.nonce,
      "X-Signature": protected1.sigB64,
    },
    body: protected1.bodyRaw,
  });
  const replayData = await replayResp.json();
  print("Protected response #2 (replay)", replayData);

  // 7) Fund Agent A wallet (demo mint)
  const fund = await postJson(`${BASE}/v1/agents/${agentAId}/wallet/fund`, {
    amountCents: 1000,
    note: "Demo funding",
  });
  print("Fund response", fund);

  // 8) Set strict policy for Agent A: max $4.00 per transfer/escrow
  const setPolicy = await postJson(`${BASE}/v1/agents/${agentAId}/policy`, { maxTxCents: 400 });
  print("Policy set response", setPolicy);

  const getPolicy = await getJson(`${BASE}/v1/agents/${agentAId}/policy`);
  print("Policy", getPolicy.data);

  // 9) Wallet A snapshot
  const walletA0 = await getJson(`${BASE}/v1/agents/${agentAId}/wallet`);
  print("Wallet A (before transfer)", walletA0.data);

  // 10) Transfer A -> B ($3.00) (SIGNED by Agent A)
  const transferGood = await postSignedJson({
    agentId: agentAId,
    privateKeyPem: agentAKeys.privateKeyPem,
    path: "/v1/tx/transfer",
    body: {
      toAgentId: agentBId,
      amountCents: 300,
      note: "Demo transfer A->B",
    },
  });
  print("Transfer response (good)", transferGood.data);

  // 10B) Retry the SAME transfer with the SAME idempotency key (should NOT double-charge)
const fixedTransferBody = JSON.stringify({
  toAgentId: agentBId,
  amountCents: 300,
  note: "Idempotency test transfer",
});

const fixedTs1 = Date.now().toString();
const fixedNonce1 = Math.random().toString(36).slice(2);
const fixedPath = "/v1/tx/transfer";
const fixedIdemKey = randomUUID();

const fixedMsg1 = buildMessage(agentAId, fixedTs1, fixedNonce1, "POST", fixedPath, fixedTransferBody);
const fixedSig1 = sign(null, Buffer.from(fixedMsg1, "utf8"), agentAKeys.privateKeyPem).toString("base64");

const idemResp1 = await fetch(`${BASE}${fixedPath}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Agent-Id": agentAId,
    "X-Timestamp": fixedTs1,
    "X-Nonce": fixedNonce1,
    "X-Signature": fixedSig1,
    "Idempotency-Key": fixedIdemKey,
  },
  body: fixedTransferBody,
});
const idemData1 = await idemResp1.json();
print("Idempotency transfer response #1", idemData1);

// Retry same economic request with same idempotency key but NEW nonce/timestamp/signature
const fixedTs2 = Date.now().toString();
const fixedNonce2 = Math.random().toString(36).slice(2);
const fixedMsg2 = buildMessage(agentAId, fixedTs2, fixedNonce2, "POST", fixedPath, fixedTransferBody);
const fixedSig2 = sign(null, Buffer.from(fixedMsg2, "utf8"), agentAKeys.privateKeyPem).toString("base64");

const idemResp2 = await fetch(`${BASE}${fixedPath}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Agent-Id": agentAId,
    "X-Timestamp": fixedTs2,
    "X-Nonce": fixedNonce2,
    "X-Signature": fixedSig2,
    "Idempotency-Key": fixedIdemKey,
  },
  body: fixedTransferBody,
});
const idemData2 = await idemResp2.json();
print("Idempotency transfer response #2", idemData2);

  // 11) Transfer A -> B ($5.00) should fail policy
  const transferBad = await postSignedJson({
    agentId: agentAId,
    privateKeyPem: agentAKeys.privateKeyPem,
    path: "/v1/tx/transfer",
    body: {
      toAgentId: agentBId,
      amountCents: 500,
      note: "This should be blocked by policy",
    },
  });
  print("Transfer response (bad)", transferBad.data);

  // 12) Wallet snapshots
  const walletA1 = await getJson(`${BASE}/v1/agents/${agentAId}/wallet`);
  const walletB1 = await getJson(`${BASE}/v1/agents/${agentBId}/wallet`);
  console.log("Wallet A after transfer:", walletA1.data?.balanceCents, "txCount:", walletA1.data?.txCount);
  console.log("Wallet B after transfer:", walletB1.data?.balanceCents, "txCount:", walletB1.data?.txCount);

  // 13) Create escrow A -> B ($2.00) (SIGNED by Agent A)
  const escrowCreate = await postSignedJson({
    agentId: agentAId,
    privateKeyPem: agentAKeys.privateKeyPem,
    path: "/v1/escrows",
    body: {
      toAgentId: agentBId,
      amountCents: 200,
      note: "Escrow for task completion",
    },
  });
  print("Escrow create response", escrowCreate.data);

  const escrowId = escrowCreate.data?.escrowId;
  if (!escrowId) throw new Error("escrowId missing from escrow create response");

  // 14) Check escrow status
  const escrowStatus = await getJson(`${BASE}/v1/escrows/${escrowId}`);
  print("Escrow status", escrowStatus.data);

  // 15) Release escrow (SIGNED, payer-only: Agent A)
  // Important: body must be deterministic ("{}") to match server signature bytes
  const releasePath = `/v1/escrows/${escrowId}/release`;
  const escrowRelease = await postSignedJson({
    agentId: agentAId,
    privateKeyPem: agentAKeys.privateKeyPem,
    path: releasePath,
    body: {}, // signs "{}"
  });
  print("Escrow release raw", escrowRelease);

  // 16) Wallet B after escrow
  const walletBAfter = await getJson(`${BASE}/v1/agents/${agentBId}/wallet`);
  console.log("Wallet B after escrow:", walletBAfter.data?.balanceCents, "txCount:", walletBAfter.data?.txCount);

  // 17) (Optional) Quick audit check
  const audit = await getJson(`${BASE}/v1/audit?limit=50`);
  console.log("Audit count:", audit.data?.count);
})();