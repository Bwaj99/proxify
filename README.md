# Proxify

Financial infrastructure for autonomous AI agents: wallets, escrow, payment intents, spending policies, an
append-only audit log and webhooks. Every agent request is Ed25519-signed, so the payer can be an AI and the
server still knows exactly who authorised exactly what. Think "Stripe for a world where the payer is an agent."

**Stack:** TypeScript, Express 5, PostgreSQL + Drizzle ORM, Node `crypto` (Ed25519), Zod, Vitest.

```bash
npm install
npm run demo     # zero setup: boots the API on embedded Postgres and walks through the whole flow
npm test         # 45 end-to-end tests, also zero setup
```

## Run it

| Goal | Command |
|---|---|
| Dev server, zero setup (embedded Postgres, in-memory) | `npm run dev` |
| Dev server on real Postgres | `docker compose up -d postgres`, set `DATABASE_URL` in `.env`, `npm run dev` |
| Whole stack in Docker (production mode) | `ADMIN_TOKEN=<16+ chars> docker compose --profile app up --build` |
| Demo against a running server | `PROXIFY_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... npm run demo` |
| Dashboard | http://localhost:3000/dashboard (browser prompts: any username, **password = ADMIN_TOKEN**) |

Migrations run on startup (`RUN_MIGRATIONS=false` to disable). Copy `.env.example` for every option.

## Concepts

- **Org → Controller → Agent.** Agents are the leaves; each has a wallet, a spending policy and an Ed25519 key pair.
  The private key never leaves the agent; the server stores only the public key.
- **Wallets** hold integer cents (`bigint` + `CHECK balance >= 0`). No floats anywhere.
- **Transfers** move money agent → agent immediately.
- **Escrow** locks the payer's funds. The **payer** can *release* to the worker; the **worker** can *refund* to the
  payer. Neither side can take the money unilaterally, and once settled it can't be settled again.
- **Payment intents** are "authorise now, capture later" with optional expiry. Capture is payer-only.
- **Policies**: `maxTxCents` per transaction and an optional rolling-24h `dailyLimitCents`, enforced server-side
  after the payer's wallet is locked, so a valid signature (or a burst of concurrent requests) can't get past them.
- **Kill-switch**: an operator can suspend an agent; its signed requests fail immediately.
- **Audit log**: every money movement, policy change, provisioning action *and every rejected attempt*
  (policy violation, insufficient funds, wrong caller…). Append-only, enforced by a database trigger.
- **Webhooks**: org-level endpoints receive audit events, HMAC-signed, retried with backoff.

## Security model

**Signed requests.** Every agent call carries `X-Agent-Id`, `X-Timestamp` (ms), `X-Nonce`, `X-Signature` (base64).
The signed string is

```
agentId \n timestamp \n nonce \n METHOD \n path+query \n rawBody
```

built from the *raw bytes* of the request. Change the amount, recipient, path, query string or method and the
signature fails. Newline separators mean fields can't bleed into each other.

**Verification order** (cheapest / least state-changing first): headers → timestamp window → agent exists →
signature → agent ACTIVE → nonce consumed. The nonce is only recorded *after* the signature verifies, so anonymous
callers can't fill the table or burn someone else's nonces.

**Replay protection.** ±`SIGNATURE_WINDOW_MS` (default 2 min) timestamp window **plus** a nonce table with a
`(agent, nonce)` primary key: a captured request can never be replayed, across restarts and across instances.

**Idempotency.** `Idempotency-Key` is required on transfers (optional on escrows/intents). Keys are per agent;
the key row is claimed in the *same transaction* as the money movement, so concurrent duplicates block and replay
the first response, a failed attempt doesn't burn the key, and reusing a key with a different request is `422`.

**Concurrency.** Money paths lock wallet rows `FOR UPDATE` in sorted order (no lost updates, no deadlocks) and use
relative `balance = balance + Δ` updates. Escrow/intents lock their own row so double-release / double-capture
resolve to one winner.

**Access control.** Reads are private: an agent sees only its own wallet, ledger, policy and audit (signed), and
only escrows/intents it is a party to (others get `404`, so ids can't be probed). Provisioning, funding, policy
changes, suspension, org-wide audit, webhooks and dashboards require the admin token. In production the server
refuses to start without `ADMIN_TOKEN` and `DATABASE_URL`.

**Defence in depth.** DB `CHECK` constraints and foreign keys, a bigint overflow guard, request-size limit, per-IP
rate limit, security headers, HTML-escaped dashboards, no internal errors in 5xx bodies, request ids on every
response and log line, graceful shutdown.

## API (all under `/v1`)

Errors are `{ "error": "message", "code": "MACHINE_CODE", "details"?: {...} }`.

**Agent (signed)** — use the SDK, or sign requests as above

| Method | Path | Notes |
|---|---|---|
| GET | `/agents/:id/wallet` | balance + last 20 ledger rows (self only) |
| GET | `/agents/:id/ledger?limit&before` | paginated ledger |
| GET | `/agents/:id/policy` | |
| GET | `/audit/agents/:id?limit&cursor` | cursor-paginated audit trail |
| POST | `/tx/transfer` | `{toAgentId, amountCents, note?}` + `Idempotency-Key` (required) |
| POST | `/escrows` | `{toAgentId, amountCents, note?}` |
| GET | `/escrows/:id` | payer or worker |
| POST | `/escrows/:id/release` | payer only |
| POST | `/escrows/:id/refund` | worker only |
| POST | `/intents` | `{toAgentId, amountCents, note?, expiresAt?}` |
| GET | `/intents/:id` | payer or payee |
| POST | `/intents/:id/capture` · `/cancel` | payer only |

**Admin** (`X-Admin-Token` header)

| Method | Path | Notes |
|---|---|---|
| POST | `/orgs`, `/controllers` | |
| POST | `/agents/register` | `{orgId, controllerId, publicKeyPem, maxTxCents?, dailyLimitCents?}` (Ed25519 SPKI PEM only) |
| PATCH | `/agents/:id` | `{status: "ACTIVE" \| "SUSPENDED"}` |
| POST | `/agents/:id/wallet/fund` | mints money — demo/ops only |
| POST | `/agents/:id/policy` | `{maxTxCents?, dailyLimitCents? (null = unlimited)}` |
| GET | `/audit?orgId&agentId&limit&cursor` | org-wide audit |
| POST/GET/DELETE | `/orgs/:id/webhooks` | secret shown once |
| GET | `/dashboard/stats`, `/dashboard/feeds` | aggregates computed in SQL |

Plus `GET /health`, `GET /health/db`, and the HTML views `/dashboard` and `/audit-view`.

## SDK

```ts
import { ProxifyAdmin, ProxifyAgent, generateAgentKeys } from "./src/sdk/agent";

const admin = new ProxifyAdmin("http://localhost:3000", process.env.ADMIN_TOKEN);
const org = await admin.createOrg("Acme");
const ctl = await admin.createController(org.orgId, "research-team");

const keys = generateAgentKeys();                       // private key stays with the agent
const { agentId } = await admin.registerAgent({ orgId: org.orgId, controllerId: ctl.controllerId, publicKeyPem: keys.publicKeyPem });

const agent = new ProxifyAgent({ baseUrl: "http://localhost:3000", agentId, privateKeyPem: keys.privateKeyPem });
const escrow = await agent.createEscrow(workerId, 3_000, "scrape 500 pages");
await agent.releaseEscrow(escrow.escrowId);             // after verifying the work
```

The SDK signs every request, generates a fresh nonce per attempt, and retries network failures / 5xx / 429 with
the *same* idempotency key, so retries can never double-spend. Requests without a key (escrow release, capture…)
are never blindly retried.

## Webhooks

Register an `https://` URL (plain `http://` only with `ALLOW_INSECURE_WEBHOOKS=true` in development):
`POST /v1/orgs/:orgId/webhooks {"url": "..."}` → returns a `whsec_…` secret **once**.

Events are written to an outbox **in the same transaction** as the change they describe (committed change ⇔ event;
a rolled-back transfer never emits `TRANSFER_SUCCEEDED`). A worker claims due deliveries with
`FOR UPDATE SKIP LOCKED` (safe to run on several instances) and POSTs:

```
X-Proxify-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
X-Proxify-Event-Id:  <audit event id>          # dedupe on this: delivery is at-least-once
{ "id", "type": "TRANSFER_SUCCEEDED", "createdAt", "data": { agentId, targetAgentId, amountCents, ... } }
```

Non-2xx / timeouts retry with exponential backoff (5 s doubling, capped at 1 h) up to `WEBHOOK_MAX_ATTEMPTS`
(default 8), then `FAILED`. Redirects are not followed. Reject signatures whose `t` is stale.

## Project layout

```
src/
  config.ts            validated env config (fails fast)
  app.ts / index.ts    Express app factory / process entry (graceful shutdown)
  db/                  Drizzle schema + client (node-postgres, or embedded PGlite when DATABASE_URL is unset)
  lib/                 canonical signed string (shared with the SDK), errors, validation helpers
  middleware/          signature + admin auth, request context, error handling
  services/            payments (transfer/escrow/intents), wallets (locks, policy), idempotency, audit, webhooks, provisioning
  routes/              agent (signed), admin, dashboard
  sdk/agent.ts         ProxifyAgent + ProxifyAdmin
  demo/runDemo.ts
drizzle/               generated migrations + a hand-written one for the audit-immutability trigger
test/                  end-to-end tests (real HTTP, real SQL)
```

## Testing

`npm test` runs the suite against embedded PostgreSQL. CI additionally runs it against a real Postgres service
(`TEST_DATABASE_URL`), which is what exercises genuine row-lock contention. Covers signing/tamper/replay,
access control, idempotency (including concurrent duplicates), policy + daily limits, escrow/intents state
machines, concurrent double-spend/double-release, audit immutability and pagination, webhook signing/retry/outbox.

## Upgrading from 0.1

Breaking changes: the signed string is now newline-delimited and covers the query string; reads are signed;
registration, funding and policy changes need the admin token; `PUT`-style policy body is
`{maxTxCents?, dailyLimitCents?}`; escrow statuses are `LOCKED | RELEASED | REFUNDED`; money columns are `bigint`.
Run the new migrations (`npm run db:migrate` or just start the server); adding foreign keys will fail if legacy
rows reference agents that don't exist.

## Known limitations / roadmap

- No multi-party escrow, escrow expiry/auto-refund, dispute flow, or agent key rotation yet.
- The per-IP rate limiter is in-process memory; behind several instances use a shared store (e.g. Redis) or the
  gateway's limiter. Per-agent rate limits aren't implemented.
- `/fund` mints money by design (demo/ops); a real deployment would front it with a payment provider.
- Webhook delivery is at-least-once. Endpoint URLs are admin-supplied; add egress filtering (block private
  address ranges) if you let untrusted parties register them.
- Audit rows are immutable at the database level, but not cryptographically chained; a DBA with superuser rights
  can still drop the trigger.
