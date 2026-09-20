import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors";

export const requestContext = (opts: { log: boolean }): RequestHandler => (req, res, next) => {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.set("X-Request-Id", req.requestId);
  const start = process.hrtime.bigint();
  if (opts.log) {
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(
        JSON.stringify({ t: new Date().toISOString(), id: req.requestId, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Math.round(ms) }),
      );
    });
  }
  next();
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  next();
};

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(new AppError(404, "ROUTE_NOT_FOUND", "Route not found"));

/** One place turns every failure into `{ error, code, details? }`. 5xx never leaks internals. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    return void res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  const e = err as { type?: string };
  if (e?.type === "entity.parse.failed") return void res.status(400).json({ error: "Malformed JSON body", code: "INVALID_JSON" });
  if (e?.type === "entity.too.large") return void res.status(413).json({ error: "Body too large", code: "PAYLOAD_TOO_LARGE" });
  console.error(JSON.stringify({ level: "error", id: req.requestId, message: (err as Error)?.message, stack: (err as Error)?.stack }));
  res.status(500).json({ error: "Internal server error", code: "INTERNAL", requestId: req.requestId });
};
