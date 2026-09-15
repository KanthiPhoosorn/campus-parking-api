import { describe, expect, it } from "vitest";
import {
  requestFingerprint,
  signWebhook,
  timingSafeEqual,
  verifyWebhookSignature,
} from "../src/integration";

// A5 regression tests. These pin the two properties the integration evidence
// depends on: a forged/replayed webhook is rejected, and "the same request"
// means the same canonical body regardless of key order.

const secret = "test-secret";
const body = JSON.stringify({ event: "zone.updated", data: { id: 1, free: 4 } });

describe("webhook signature", () => {
  it("accepts a signature produced by signWebhook", async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    const result = await verifyWebhookSignature(secret, body, header, { nowSeconds: 1_000_010 });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a tampered body", async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    const tampered = body.replace('"free":4', '"free":40');
    const result = await verifyWebhookSignature(secret, tampered, header, { nowSeconds: 1_000_010 });
    expect(result.valid).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const header = await signWebhook("someone-else", body, 1_000_000);
    const result = await verifyWebhookSignature(secret, body, header, { nowSeconds: 1_000_010 });
    expect(result.valid).toBe(false);
  });

  it("rejects a replay outside the tolerance window", async () => {
    const header = await signWebhook(secret, body, 1_000_000);
    const result = await verifyWebhookSignature(secret, body, header, { nowSeconds: 1_000_000 + 301 });
    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining("replay window") });
  });

  it("rejects a missing or malformed header", async () => {
    expect((await verifyWebhookSignature(secret, body, undefined)).valid).toBe(false);
    expect((await verifyWebhookSignature(secret, body, "garbage")).valid).toBe(false);
  });
});

describe("idempotency fingerprint", () => {
  it("is identical for the same body with different key order", async () => {
    const a = await requestFingerprint({ name: "Zone Z", capacity: 10, free: 5 });
    const b = await requestFingerprint({ free: 5, name: "Zone Z", capacity: 10 });
    expect(a).toBe(b);
  });

  it("differs when any value changes", async () => {
    const a = await requestFingerprint({ name: "Zone Z", capacity: 10, free: 5 });
    const b = await requestFingerprint({ name: "Zone Z", capacity: 10, free: 6 });
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqual", () => {
  it("compares correctly", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
