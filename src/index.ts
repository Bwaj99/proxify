import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db/client";
import { startWebhookWorker } from "./services/webhooks";

async function main() {
  const config = loadConfig();
  const { db, close } = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir, migrate: config.runMigrations });

  if (!config.adminToken) console.warn("WARNING: ADMIN_TOKEN is not set - admin routes (provisioning, funding, dashboards) are OPEN. Development only.");
  if (!config.databaseUrl) console.warn(`DATABASE_URL not set - using embedded PGlite (${config.pgliteDir ?? "in-memory; data is lost on exit"}).`);

  const app = createApp(db, config);
  const stopWorker = config.webhooksEnabled ? startWebhookWorker(db, config) : async () => {};
  const server = app.listen(config.port, () => console.log(`Proxify listening on http://localhost:${config.port}`));

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await stopWorker();
      await close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
