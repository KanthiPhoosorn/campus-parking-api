// Machine-credential helpers (Parts 13-15).

/** Hash a credential before storing/comparing it. The raw key is never persisted. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a random machine key. Returned to the caller exactly once. */
export function createApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `wk_${encoded}`;
}

/** Machine identity uses its own scheme ("ApiKey"), never a human Bearer token. */
export function readApiKey(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("ApiKey ")) return null;
  const key = authorization.slice("ApiKey ".length).trim();
  return key.length > 0 ? key : null;
}
