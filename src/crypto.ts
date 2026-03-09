import * as ed from "@noble/ed25519";

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = hexToBytes(signatureHex);
  const pubBytes = hexToBytes(publicKeyHex);
  return ed.verify(sigBytes, msgBytes, pubBytes);
}