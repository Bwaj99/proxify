/** Header names shared by the server and the SDK. */
export const HEADERS = {
  agentId: "x-agent-id",
  timestamp: "x-timestamp",
  nonce: "x-nonce",
  signature: "x-signature",
  idempotencyKey: "idempotency-key",
  adminToken: "x-admin-token",
} as const;

export interface CanonicalParts {
  agentId: string;
  timestamp: string;
  nonce: string;
  method: string;
  /** Request target exactly as sent: path AND query string. */
  path: string;
  /** Raw request body ("" when there is none). */
  body: string;
}

/**
 * The exact string that is signed. Newline-delimited (a character that can't
 * appear in the UUID / numeric / base64url fields) so fields can't bleed into
 * one another. Both sides build it with this one function.
 */
export function buildMessage(p: CanonicalParts): string {
  return [p.agentId, p.timestamp, p.nonce, p.method.toUpperCase(), p.path, p.body].join("\n");
}
