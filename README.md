# Proxify

Financial infrastructure for autonomous AI agents: wallets, escrow, signed transfers, policies, and audit.
The "Stripe for autonomous agents."

**Stack:** TypeScript, Express, Postgres (Drizzle ORM), Ed25519-signed requests, replay protection, idempotency.

---

## Run the demo (end-to-end)

| Step | Command |
|------|--------|
| 1. Postgres | `docker compose up -d postgres` (uses `docker-compose.yml`, Postgres on **localhost:5433**) |
| 2. Env | Set `.env` with `DATABASE_URL=postgresql://proxify:proxify_password@localhost:5433/proxify_db` (matches docker-compose) |
| 3. Migrate | `npm run db:migrate` |
| 4. Backend | `npm run dev` (leave running) |
| 5. Demo | In another terminal: `npm run demo` |
| 6. UI | Open **http://localhost:3000/dashboard** and **http://localhost:3000/audit-view** |

The demo registers two agents, funds one, creates escrow, has the worker “complete” a task, then releases escrow and prints balances + audit. The dashboard shows agents, balances, escrows, and events.

---

## Quick start (detailed)

### 1. Start Postgres (Docker)

Either use your existing container (e.g. `proxify_postgres`) or start the one defined in `docker-compose.yml`:

```bash
docker compose up -d postgres
```

This creates a `proxify_postgres` container with:

- `POSTGRES_USER=proxify`
- `POSTGRES_PASSWORD=proxify_password`
- `POSTGRES_DB=proxify_db`

and exposes it on **localhost:5433**.

### 2. Configure environment

Set `.env` in the project root so `DATABASE_URL` matches your Postgres (user, password, database). For the compose setup above:

```
DATABASE_URL=postgresql://proxify:proxify_password@localhost:5433/proxify_db
```

### 3. Run migrations

```bash
npm run db:migrate
```

### 4. Start the backend

```bash
npm run dev
```

Server runs at **http://localhost:3000**.

### 5. Run the demo

In another terminal (with the backend running):

```bash
npm run demo
```

This runs the full agent-to-agent flow:

- register Agent A (payer) and Agent B (worker)
- fund Agent A’s wallet and set a spending policy
- Agent A creates an escrow for Agent B for a research task
- Agent B completes the task deterministically
- Agent A verifies the output and releases escrow
- final balances and recent audit events are printed in a narrative format

### 6. Open the dashboard

In a browser:

- **http://localhost:3000/dashboard** — agents, wallet balances, escrows, recent audit
- **http://localhost:3000/audit-view** — full audit log (optional filter by agent ID)

There is also a lightweight health check:

- **http://localhost:3000/health/db** — verifies the backend can reach Postgres

---

## Database connection: finding the correct password

**`password authentication failed for user "proxify"` (or similar)** means the username or password in `.env` doesn’t match your Postgres instance.

- **If you use the `proxify_postgres` container from `docker-compose.yml` (with POSTGRES_USER=proxify)**  
  Use in `.env`:  
  `DATABASE_URL=postgresql://proxify:proxify_password@localhost:5433/proxify_db`  
  (Replace password/db if you set different `POSTGRES_PASSWORD` / `POSTGRES_DB`.)

- **To see the actual credentials** of a running Postgres container:  
  `docker exec <container_name> printenv | findstr POSTGRES`  
  Then set `DATABASE_URL=postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5433/<POSTGRES_DB>`.

- **If you use the default Postgres image** (no POSTGRES_USER) it creates user **`postgres`**; use that and your `POSTGRES_PASSWORD` / `POSTGRES_DB` in the URL (and adjust the port to match your mapping).

- **If you forgot the password**  
  You can’t retrieve it from the image; run `docker exec <container> printenv | findstr POSTGRES` to see what’s set. To reset: remove the container and create a new one with new env vars.

- **Password still rejected?** The Postgres on `localhost:5433` might be a *different* instance (another container or local install). Run `docker ps` and check which container maps port 5433. If it’s not `proxify_postgres`, either stop the other one or change the port and update `DATABASE_URL`. Then run `npm run db:ping` to verify.

---

## Architecture summary

- **Orgs / Controllers / Agents** — hierarchy: org → controllers → agents. Each agent has an Ed25519 key pair; the public key is stored at registration.
- **Wallets** — one wallet per agent; balance in cents. Funding is a privileged (unsigned) operation for demo; transfers and escrow are signed.
- **Policies** — per-agent `maxTxCents` limit for transfers and escrow.
- **Transfers** — signed by the sender, idempotent via `Idempotency-Key` header.
- **Escrow** — payer creates escrow (signed); only the payer can release (signed). Funds move to the recipient on release.
- **Audit** — all value-moving and policy events are written to `audit_events`.
- **Auth** — canonical message format: `agentId.timestamp.nonce.method.path.body`. Signed with Ed25519; server verifies and enforces timestamp window + nonce replay protection.

---

## API endpoints (summary)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/orgs` | — | Create org |
| POST | `/v1/controllers` | — | Create controller |
| POST | `/v1/agents/register` | — | Register agent (public key) |
| GET | `/v1/agents/:agentId/wallet` | — | Get wallet + balance |
| POST | `/v1/agents/:agentId/wallet/fund` | — | Fund wallet (demo) |
| GET/POST | `/v1/agents/:agentId/policy` | — | Get/set policy (maxTxCents) |
| POST | `/v1/tx/transfer` | Signed + Idempotency-Key | Transfer to another agent |
| POST | `/v1/escrows` | Signed | Create escrow |
| GET | `/v1/escrows/:escrowId` | — | Get escrow |
| POST | `/v1/escrows/:escrowId/release` | Signed (payer only) | Release escrow |
| GET | `/v1/audit` | — | List audit events (optional orgId, agentId, limit) |
| GET | `/v1/audit/agents/:agentId` | — | Audit events for one agent |

---

## SDK usage

Use the Agent SDK for signed calls from an autonomous agent (Node or browser with fetch):

```ts
import { ProxifyAgent } from "./sdk/agent";

const agent = new ProxifyAgent({
  baseUrl: "http://localhost:3000",
  agentId: "<your-agent-uuid>",
  privateKeyPem: "<PEM string>",
});

// Read-only (no signature)
const balance = await agent.getBalance();
const policy = await agent.getPolicy();
const escrow = await agent.getEscrow(escrowId);
const audit = await agent.getAudit(20);

// Signed
await agent.transfer(toAgentId, 500, "Payment");
const { escrowId } = await agent.createEscrow(toAgentId, 300, "Task payment");
await agent.releaseEscrow(escrowId);
```

The SDK attaches `X-Agent-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature`, and `Idempotency-Key` (for transfers) as required.

For quick DB connectivity checks (before running migrations or the demo), you can also run:

```bash
npx ts-node scripts/ping-db.ts
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend (ts-node-dev) |
| `npm run demo` | Run full agent-to-agent demo |
| `npm run db:migrate` | Apply Drizzle migrations |
| `npm run db:generate` | Generate migrations from schema |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:ping` | Quick Postgres connectivity check (`scripts/ping-db.ts`) |
