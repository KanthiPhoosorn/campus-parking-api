// Assignment 5 - interface between groups.
// Pure helpers for webhook signing/verification and idempotency. Kept free of
// Hono/D1 so they can be unit-tested and reused by whichever partner integrates.

const enc = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare so a signature check cannot leak by timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Signature header format (Stripe-style, so partners can reuse existing code):
 *   X-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
 * Signing the timestamp together with the body is what makes replays detectable.
 */
export async function signWebhook(
  secret: string,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${nowSeconds}.${rawBody}`);
  return `t=${nowSeconds},v1=${v1}`;
}

export type VerifyResult = { valid: true } | { valid: false; reason: string };

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {}
): Promise<VerifyResult> {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!header) return { valid: false, reason: "missing X-Webhook-Signature header" };
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.trim().split("=") as [string, string])
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { valid: false, reason: "malformed signature header" };
  if (Math.abs(now - t) > tolerance) {
    return { valid: false, reason: `timestamp outside ${tolerance}s replay window` };
  }
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v1)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}

/**
 * Idempotency: the same key may only ever be paired with the same request.
 * We hash a canonical form of the body so that key order / whitespace do not
 * turn one logical request into two.
 */
export async function requestFingerprint(body: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeys(body));
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/** ISO-8601 with milliseconds - every piece of evidence carries one of these. */
export function nowIso(): string {
  return new Date().toISOString();
}
