import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInteraction } from "./verify";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString(
  "hex"
);
const NOW = 1_800_000_000_000;
const timestamp = String(NOW / 1000);
const body = JSON.stringify({ type: 1 });
const signatureFor = (ts: string, raw: string) =>
  sign(null, Buffer.from(ts + raw), privateKey).toString("hex");

const check = (overrides: Partial<Parameters<typeof verifyInteraction>[0]> = {}) =>
  verifyInteraction({
    rawBody: body,
    signature: signatureFor(timestamp, body),
    timestamp,
    publicKey: publicKeyHex,
    now: NOW,
    ...overrides,
  });

describe("verifyInteraction", () => {
  it("accepts a correctly signed request", () => {
    expect(check()).toBe(true);
  });

  it("rejects a tampered body or a signature from another key", () => {
    expect(check({ rawBody: JSON.stringify({ type: 2 }) })).toBe(false);
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(
      check({ signature: sign(null, Buffer.from(timestamp + body), other).toString("hex") })
    ).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(check({ signature: null })).toBe(false);
    expect(check({ timestamp: null })).toBe(false);
    expect(check({ signature: "zz" })).toBe(false);
    expect(check({ timestamp: "soon" })).toBe(false);
  });

  it("rejects timestamps more than 5 minutes off, either way", () => {
    for (const skew of [-301, 301]) {
      const ts = String(NOW / 1000 + skew);
      expect(check({ timestamp: ts, signature: signatureFor(ts, body) })).toBe(false);
    }
    const ts = String(NOW / 1000 - 299);
    expect(check({ timestamp: ts, signature: signatureFor(ts, body) })).toBe(true);
  });

  it("throws on a misconfigured public key", () => {
    expect(() => check({ publicKey: "not-hex" })).toThrow(/64 hex characters/);
  });
});
