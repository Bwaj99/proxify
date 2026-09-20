import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { sql } from "drizzle-orm";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { errorHandler, notFoundHandler, requestContext, securityHeaders } from "./middleware/common";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { dashboardRoutes } from "./routes/dashboard";

export function createApp(db: Db, config: Config): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.env === "production" ? 1 : false);

  app.use(requestContext({ log: config.env !== "test" }));
  app.use(securityHeaders);
  // Keep the exact bytes the client signed: re-serialising parsed JSON would not be byte-identical.
  app.use(
    express.json({
      limit: "100kb",
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => void res.json({ ok: true }));
  app.get("/health/db", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: "Database unavailable" });
    }
  });

  const v1 = express.Router();
  if (config.rateLimitPerMin > 0) {
    v1.use(rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMin, standardHeaders: "draft-7", legacyHeaders: false }));
  }
  v1.use(agentRoutes(db, config));
  v1.use(adminRoutes(db, config));
  app.use("/v1", v1);
  app.use(dashboardRoutes(db, config));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
