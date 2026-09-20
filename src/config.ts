import "dotenv/config";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().optional(),
  /** Persist the embedded dev database here when DATABASE_URL is unset. */
  PGLITE_DIR: z.string().optional(),
  RUN_MIGRATIONS: bool(true),
  /** Guards provisioning, funding, policy changes and the dashboards. */
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters").optional(),
  /** Max clock skew for signed requests. Nonces are retained for twice this. */
  SIGNATURE_WINDOW_MS: z.coerce.number().int().positive().default(120_000),
  /** Per-IP requests/minute on /v1. 0 disables. */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(600),
  WEBHOOKS_ENABLED: bool(true),
  WEBHOOK_POLL_MS: z.coerce.number().int().positive().default(2_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  /** Allow http:// (non-TLS) webhook URLs. Development only. */
  ALLOW_INSECURE_WEBHOOKS: bool(false),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  databaseUrl?: string;
  pgliteDir?: string;
  runMigrations: boolean;
  adminToken?: string;
  signatureWindowMs: number;
  rateLimitPerMin: number;
  webhooksEnabled: boolean;
  webhookPollMs: number;
  webhookMaxAttempts: number;
  allowInsecureWebhooks: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. `ADMIN_TOKEN=` in a .env file) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    if (!e.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is required in production");
    if (!e.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
    if (e.ALLOW_INSECURE_WEBHOOKS) throw new Error("ALLOW_INSECURE_WEBHOOKS must not be enabled in production");
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    ...(e.DATABASE_URL ? { databaseUrl: e.DATABASE_URL } : {}),
    ...(e.PGLITE_DIR ? { pgliteDir: e.PGLITE_DIR } : {}),
    runMigrations: e.RUN_MIGRATIONS,
    ...(e.ADMIN_TOKEN ? { adminToken: e.ADMIN_TOKEN } : {}),
    signatureWindowMs: e.SIGNATURE_WINDOW_MS,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    webhooksEnabled: e.WEBHOOKS_ENABLED,
    webhookPollMs: e.WEBHOOK_POLL_MS,
    webhookMaxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
    allowInsecureWebhooks: e.ALLOW_INSECURE_WEBHOOKS,
  };
}
