import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** Reject signed requests whose timestamp is further than this from now (replay protection). */
export const MAX_TIMESTAMP_SKEW_S = 5 * 60;

const keys = new Map<string, KeyObject>();

/** Discord gives the Ed25519 public key as 64 hex chars; Node wants it as a JWK. */
function importPublicKey(hex: string): KeyObject {
  const cached = keys.get(hex);
  if (cached) return cached;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("The Discord public key must be 64 hex characters (DISCORD_PUBLIC_KEY)");
  }
  const key = createPublicKey({
    format: "jwk",
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") },
  });
  keys.set(hex, key);
  return key;
}

export interface VerifyInput {
  /** The exact request body, before any JSON parsing. */
  rawBody: string;
  /** `X-Signature-Ed25519` */
  signature: string | null;
  /** `X-Signature-Timestamp` (unix seconds) */
  timestamp: string | null;
  /** The application's public key, as hex. */
  publicKey: string;
  /** Milliseconds since the epoch; for tests. */
  now?: number;
}

/**
 * Verify Discord's Ed25519 signature over `timestamp + rawBody`. Discord probes the endpoint with
 * bad signatures when the URL is saved (and now and then afterwards) and expects a 401 for them.
 */
export function verifyInteraction({
  rawBody,
  signature,
  timestamp,
  publicKey,
  now = Date.now(),
}: VerifyInput): boolean {
  const key = importPublicKey(publicKey);
  if (!signature || !timestamp) return false;
  if (!/^[0-9a-f]{128}$/i.test(signature) || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_TIMESTAMP_SKEW_S) return false;

  return verify(null, Buffer.from(timestamp + rawBody, "utf8"), key, Buffer.from(signature, "hex"));
}
