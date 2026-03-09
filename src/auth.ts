export function buildMessage(
  agentId: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: string
): string {
  return `${agentId}.${timestamp}.${nonce}.${method}.${path}.${body}`;
}