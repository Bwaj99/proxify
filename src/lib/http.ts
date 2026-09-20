import { z } from "zod";
import { badRequest } from "./errors";

/** Largest exactly-representable integer; amounts above this are rejected outright. */
export const MAX_CENTS = Number.MAX_SAFE_INTEGER;

export const zUuid = z.string().uuid();
export const zCents = z.number().int().positive().max(MAX_CENTS);
export const zNote = z.string().max(500);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw badRequest(msg, "VALIDATION_ERROR");
  }
  return r.data;
}

export function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Minimal HTML escaping for the server-rendered dashboards. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
