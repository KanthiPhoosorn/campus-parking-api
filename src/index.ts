import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { canReadZone, canWriteZone, hasRole, hasScope, type User } from "./authz";
import { createApiKey, readApiKey, sha256Hex } from "./security";
import {
  nowIso,
  requestFingerprint,
  signWebhook,
  verifyWebhookSignature,
} from "./integration";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  AUTH_MODE: string;
  ENABLE_INSECURE_LAB_DEMO: string;
  AUTH_JWKS_URL?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  // Assignment 5 - partner integration. URLs are plain vars; secrets are
  // `wrangler secret` values and never appear in wrangler.jsonc or git.
  PARTNER_BASE_URL?: string;        // e.g. https://partner-team.workers.dev
  PARTNER_ZONES_PATH?: string;      // e.g. /api/zones
  PARTNER_WEBHOOK_URL?: string;     // where WE deliver webhooks
  PARTNER_SIMULATE_DOWN?: string;   // "true" forces the degraded path (evidence)
  PARTNER_API_KEY?: string;         // secret: credential the partner issued to us
  INBOUND_WEBHOOK_SECRET?: string;  // secret: partner signs webhooks TO us with this
  OUTBOUND_WEBHOOK_SECRET?: string; // secret: we sign webhooks TO the partner with this
};
type Variables = { externalSub: string; jwtPayload?: { sub?: string }; partnerClient?: ApiClient };
type AppEnv = { Bindings: Bindings; Variables: Variables };
type AppContext = Context<AppEnv>;

type AppUser = User & { external_sub: string; email: string | null };
type ZoneRow = {
  id: number;
  name: string;
  capacity: number;
  free: number;
  permit_type: string;
  operator_user_id: number;
  operator_note: string | null;
  created_at: string;
  updated_at: string;
};
type ApiClient = { id: number; name: string; scopes_json: string; revoked_at: string | null };

const app = new Hono<AppEnv>();
app.use("/*", cors());

// ---------------------------------------------------------------------------
// Part 3/4 - Authentication. Demo mode simulates claims that a real identity
// provider would have verified, and is hard-restricted to development so it can
// never authenticate anything in production.
// ---------------------------------------------------------------------------
const DEMO_SUBJECTS = ["demo-alice", "demo-bob", "demo-admin"];

function isDemoMode(c: AppContext): boolean {
  return c.env.ENVIRONMENT === "development" && c.env.AUTH_MODE === "demo";
}

const authenticateHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/, "").trim();

  if (isDemoMode(c)) {
    if (!token || !DEMO_SUBJECTS.includes(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("externalSub", token);
    return next();
  }

  // Real deployment path: verify the provider JWT (signature, iss, aud, exp).
  if (!c.env.AUTH_JWKS_URL || !c.env.AUTH_ISSUER || !c.env.AUTH_AUDIENCE) {
    return c.json({ error: "OIDC configuration is incomplete" }, 500);
  }
  const { jwk } = await import("hono/jwk");
  const verify = jwk({
    jwks_uri: c.env.AUTH_JWKS_URL,
    // Must match what the identity provider actually signs with - do not assume.
    alg: ["RS256"],
    verification: { iss: c.env.AUTH_ISSUER, aud: c.env.AUTH_AUDIENCE },
  });
  const failed = await verify(c, async () => undefined);
  if (failed instanceof Response) return failed;
  const sub = c.get("jwtPayload")?.sub;
  if (!sub) return c.json({ error: "Token has no subject claim" }, 401);
  c.set("externalSub", sub);
  return next();
};

app.use("/api/*", authenticateHuman);
app.use("/lab/*", authenticateHuman);

// Part 5 - map the external identity to OUR user record. Never trust a client id.
async function getCurrentUser(c: AppContext): Promise<AppUser | null> {
  return c.env.DB.prepare("SELECT id, external_sub, email, role FROM users WHERE external_sub = ?")
    .bind(c.get("externalSub"))
    .first<AppUser>();
}

async function requireCurrentUser(c: AppContext): Promise<AppUser | Response> {
  const user = await getCurrentUser(c);
  return user ?? c.json({ error: "Identity is not mapped to an application user" }, 403);
}

const isResponse = (v: AppUser | Response): v is Response => v instanceof Response;

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// PUBLIC - availability feed. Deliberately unauthenticated: this is the product.
// It exposes NO operator_note and NO operator_user_id.
// ---------------------------------------------------------------------------
app.get("/", (c) =>
  c.json({
    name: "Campus Parking Zones API",
    security: "Week 05 trust boundary: AuthN -> role -> ownership -> scope",
    public: ["GET /public/zones"],
    authenticated: ["GET /api/me", "GET /api/zones/:id", "PATCH /api/zones/:id", "POST /api/zones"],
    admin: ["DELETE /api/admin/users/:id", "POST /api/admin/api-clients"],
    machine: ["GET /machine/zones", "POST /machine/zones"],
    partner: {
      provider: ["GET /partner/zones", "POST /partner/zones (Idempotency-Key required)"],
      webhooks: ["POST /webhooks/partner (X-Webhook-Signature: t=<unix>,v1=<hmac-sha256>)"],
      consumer: ["GET /integration/partner/zones"],
    },
  })
);

app.get("/public/zones", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, capacity, free, permit_type FROM zones ORDER BY id"
  ).all();
  return c.json({ count: results.length, data: results });
});

// ---------------------------------------------------------------------------
// AUTHENTICATED
// ---------------------------------------------------------------------------
app.get("/api/me", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  return c.json({ id: user.id, email: user.email, role: user.role });
});

// Part 8 - private record: authentication AND ownership.
app.get("/api/zones/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id must be a positive integer" }, 400);

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?").bind(id).first<ZoneRow>();
  // 404 (not 403) for both "missing" and "not yours", so IDs cannot be enumerated.
  if (!zone || !canReadZone(user, zone)) return c.json({ error: "Not found" }, 404);
  return c.json(zone);
});

app.patch("/api/zones/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id must be a positive integer" }, 400);

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?").bind(id).first<ZoneRow>();
  if (!zone || !canWriteZone(user, zone)) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ free?: unknown; operator_note?: unknown }>()
    .catch(() => ({} as { free?: unknown; operator_note?: unknown }));
  const free = typeof body.free === "number" && Number.isInteger(body.free) ? body.free : zone.free;
  const note = typeof body.operator_note === "string" ? body.operator_note : zone.operator_note;
  if (free < 0 || free > zone.capacity) {
    return c.json({ error: "free must be between 0 and capacity", capacity: zone.capacity, free }, 422);
  }

  const row = await c.env.DB.prepare(
    "UPDATE zones SET free = ?, operator_note = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
  )
    .bind(free, note, id)
    .first<ZoneRow>();
  // A5 - an availability change is the internal trigger that notifies the partner.
  if (row) c.executionCtx.waitUntil(sendWebhook(c.env, "zone.updated", publicZone(row)));
  return c.json(row);
});

// Part 11 - ownership comes from the token, never from the request body.
app.post("/api/zones", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["operator", "admin"])) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{
    name?: unknown;
    capacity?: unknown;
    free?: unknown;
    operator_user_id?: unknown;
  }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof body.capacity !== "number" || typeof body.free !== "number") {
    return c.json({ error: "capacity and free are required numbers" }, 400);
  }
  if (body.free > body.capacity) return c.json({ error: "free must be <= capacity" }, 422);

  // body.operator_user_id is IGNORED on purpose - the owner is the caller.
  const row = await c.env.DB.prepare(
    "INSERT INTO zones (name, capacity, free, operator_user_id) VALUES (?, ?, ?, ?) RETURNING *"
  )
    .bind(body.name.trim(), body.capacity, body.free, user.id)
    .first<ZoneRow>();
  return c.json(row, 201);
});

// Part 9 - admin-only, enforced on the SERVER (not by hiding a UI button).
app.delete("/api/admin/users/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(c.req.param("id")).run();
  return c.body(null, 204);
});

app.post("/api/admin/api-clients", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ name?: unknown; scopes?: unknown }>();
  if (
    typeof body.name !== "string" ||
    !Array.isArray(body.scopes) ||
    !body.scopes.every((s) => typeof s === "string")
  ) {
    return c.json({ error: "name and scopes (string array) are required" }, 400);
  }
  const apiKey = createApiKey();
  const result = await c.env.DB.prepare(
    "INSERT INTO api_clients (name, key_hash, scopes_json) VALUES (?, ?, ?)"
  )
    .bind(body.name, await sha256Hex(apiKey), JSON.stringify(body.scopes))
    .run();
  return c.json(
    {
      id: result.meta.last_row_id,
      name: body.name,
      scopes: body.scopes,
      api_key: apiKey,
      warning: "Store api_key now - only the SHA-256 hash is kept server-side.",
    },
    201
  );
});

app.post("/api/admin/api-clients/:id/revoke", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("UPDATE api_clients SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ revoked: true, id: Number(c.req.param("id")) });
});

// ---------------------------------------------------------------------------
// Part 6 - INTENTIONALLY VULNERABLE (BOLA/IDOR). Authenticated but with no
// ownership check. Disabled unless ENABLE_INSECURE_LAB_DEMO=true. Never deploy.
// ---------------------------------------------------------------------------
app.get("/lab/vulnerable/zones/:id", async (c) => {
  if (c.env.ENABLE_INSECURE_LAB_DEMO !== "true") {
    return c.json({ error: "Insecure lab endpoint is disabled" }, 404);
  }
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?")
    .bind(c.req.param("id"))
    .first<ZoneRow>();
  return zone ? c.json(zone) : c.json({ error: "Not found" }, 404);
});

// ---------------------------------------------------------------------------
// Parts 15-17 - machine identity: its own scheme, explicit scopes, revocation.
// ---------------------------------------------------------------------------
async function authenticateMachine(c: AppContext): Promise<ApiClient | null> {
  const key = readApiKey(c.req.header("Authorization"));
  if (!key) return null;
  const client = await c.env.DB.prepare(
    "SELECT id, name, scopes_json, revoked_at FROM api_clients WHERE key_hash = ?"
  )
    .bind(await sha256Hex(key))
    .first<ApiClient>();
  if (!client) return null;
  return client.revoked_at ? null : client; // a revoked credential fails authentication
}

function parseScopes(scopesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(scopesJson);
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : [];
  } catch {
    return [];
  }
}

app.get("/machine/zones", async (c) => {
  const client = await authenticateMachine(c);
  if (!client) return c.json({ error: "Invalid machine credential" }, 401);
  if (!hasScope(parseScopes(client.scopes_json), "read:zones")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, capacity, free, permit_type FROM zones ORDER BY id"
  ).all();
  return c.json({ client: client.name, zones: results });
});

app.post("/machine/zones", async (c) => {
  const client = await authenticateMachine(c);
  if (!client) return c.json({ error: "Invalid machine credential" }, 401);
  if (!hasScope(parseScopes(client.scopes_json), "write:zones")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json({ error: "Write not implemented in this lab" }, 501);
});

// ===========================================================================
// Assignment 5 - interface between groups.
// Six proofs map to six pieces below:
//   provider  -> /partner/*            (request_log)
//   idempotent-> POST /partner/zones   (idempotency_keys)
//   receiver  -> POST /webhooks/partner (webhook_inbox)
//   sender    -> sendWebhook()         (webhook_outbox)
//   consumer  -> GET /integration/partner/zones (integration_log, ok)
//   degraded  -> same route, partner down       (integration_log, degraded/recovered)
// ===========================================================================

/** The shape we expose to other teams: never operator_note / operator_user_id. */
function publicZone(z: ZoneRow) {
  return { id: z.id, name: z.name, capacity: z.capacity, free: z.free, permit_type: z.permit_type, updated_at: z.updated_at };
}

// --- 2. Provider: every /partner call is authenticated by machine key and logged.
app.use("/partner/*", async (c, next) => {
  const started = Date.now();
  await next();
  const client = c.get("partnerClient");
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "INSERT INTO request_log (method, path, client_name, status, idempotency_key, cf_ray, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        c.req.method,
        c.req.path,
        client?.name ?? null,
        c.res.status,
        c.req.header("Idempotency-Key") ?? null,
        c.req.header("cf-ray") ?? null,
        Date.now() - started
      )
      .run()
  );
});

async function requirePartner(c: AppContext, scope: string): Promise<ApiClient | Response> {
  const client = await authenticateMachine(c);
  if (!client) return c.json({ error: "Invalid machine credential" }, 401);
  if (!hasScope(parseScopes(client.scopes_json), scope)) return c.json({ error: "Forbidden", required_scope: scope }, 403);
  c.set("partnerClient", client);
  return client;
}
const isRes = (v: ApiClient | Response): v is Response => v instanceof Response;

app.get("/partner/zones", async (c) => {
  const client = await requirePartner(c, "partner:read");
  if (isRes(client)) return client;
  const { results } = await c.env.DB.prepare("SELECT * FROM zones ORDER BY id").all<ZoneRow>();
  return c.json({ provider: "team11-campus-parking", served_at: nowIso(), zones: results.map(publicZone) });
});

// --- 5. Idempotent create. The key is claimed in idempotency_keys BEFORE the
// zone is inserted, so a duplicate can only ever observe the first result.
app.post("/partner/zones", async (c) => {
  const client = await requirePartner(c, "partner:write");
  if (isRes(client)) return client;

  const key = c.req.header("Idempotency-Key")?.trim();
  if (!key) return c.json({ error: "Idempotency-Key header is required" }, 400);

  const body = await c.req.json<{ name?: unknown; capacity?: unknown; free?: unknown; permit_type?: unknown }>().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "name is required" }, 400);
  if (typeof body.capacity !== "number" || typeof body.free !== "number") return c.json({ error: "capacity and free are required numbers" }, 400);
  if (body.free > body.capacity) return c.json({ error: "free must be <= capacity" }, 422);
  const fingerprint = await requestFingerprint(body);

  // Claim the key. A PRIMARY KEY conflict means this key was seen before.
  const claim = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (client_name, key, request_hash) VALUES (?, ?, ?)"
  ).bind(client.name, key, fingerprint).run();

  if (claim.meta.changes === 0) {
    const seen = await c.env.DB.prepare(
      "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE client_name = ? AND key = ?"
    ).bind(client.name, key).first<{ request_hash: string; response_status: number | null; response_body: string | null }>();
    if (!seen) return c.json({ error: "Idempotency record vanished" }, 500);
    if (seen.request_hash !== fingerprint) {
      return c.json({ error: "Idempotency-Key was already used with a different payload" }, 409);
    }
    if (seen.response_status === null || seen.response_body === null) {
      return c.json({ error: "Original request is still being processed" }, 409);
    }
    c.header("Idempotent-Replayed", "true");
    return c.body(seen.response_body, 201, { "Content-Type": "application/json" });
  }

  // First time we see this key: perform the write, then remember the response.
  // The partner's zones are owned by the admin account (id 3 in the seed).
  const row = await c.env.DB.prepare(
    "INSERT INTO zones (name, capacity, free, permit_type, operator_user_id, operator_note) VALUES (?, ?, ?, ?, 3, ?) RETURNING *"
  )
    .bind(body.name.trim(), body.capacity, body.free, typeof body.permit_type === "string" ? body.permit_type : "student", `created via partner API by ${client.name}`)
    .first<ZoneRow>();
  const responseBody = JSON.stringify({ created: true, zone: row ? publicZone(row) : null });
  await c.env.DB.prepare(
    "UPDATE idempotency_keys SET response_status = 201, response_body = ? WHERE client_name = ? AND key = ?"
  ).bind(responseBody, client.name, key).run();

  if (row) c.executionCtx.waitUntil(sendWebhook(c.env, "zone.created", publicZone(row)));
  c.header("Idempotent-Replayed", "false");
  return c.body(responseBody, 201, { "Content-Type": "application/json" });
});

// --- 3. Webhook receiver. Reads the RAW body (signature is over the exact bytes),
// verifies HMAC + timestamp, and stores every delivery - accepted or rejected.
app.post("/webhooks/partner", async (c) => {
  const rawBody = await c.req.text();
  const header = c.req.header("X-Webhook-Signature");
  const secret = c.env.INBOUND_WEBHOOK_SECRET;
  const result = secret
    ? await verifyWebhookSignature(secret, rawBody, header)
    : ({ valid: false, reason: "receiver has no INBOUND_WEBHOOK_SECRET configured" } as const);

  let eventType: string | null = null;
  try { eventType = (JSON.parse(rawBody) as { event?: string }).event ?? null; } catch { /* keep null */ }

  const stored = await c.env.DB.prepare(
    "INSERT INTO webhook_inbox (event_type, raw_body, signature_header, signature_valid, reason) VALUES (?, ?, ?, ?, ?) RETURNING id, received_at"
  )
    .bind(eventType, rawBody, header ?? null, result.valid ? 1 : 0, result.valid ? null : result.reason)
    .first<{ id: number; received_at: string }>();

  if (!result.valid) {
    return c.json({ accepted: false, reason: result.reason, inbox_id: stored?.id }, 401);
  }
  return c.json({ accepted: true, inbox_id: stored?.id, received_at: stored?.received_at, event: eventType });
});

// --- 4. Webhook sender. Row first, HTTP second, so a failed delivery is evidence too.
async function sendWebhook(env: Bindings, triggerAction: string, data: unknown): Promise<void> {
  const target = env.PARTNER_WEBHOOK_URL;
  const secret = env.OUTBOUND_WEBHOOK_SECRET;
  const payload = JSON.stringify({ event: triggerAction, source: "team11-campus-parking", sent_at: nowIso(), data });
  const signature = secret ? await signWebhook(secret, payload) : "unsigned";

  if (!target || !secret) {
    await env.DB.prepare(
      "INSERT INTO webhook_outbox (trigger_action, target_url, payload, signature, error, completed_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(triggerAction, target ?? "(unset)", payload, signature, "PARTNER_WEBHOOK_URL or OUTBOUND_WEBHOOK_SECRET not configured", nowIso()).run();
    return;
  }

  const row = await env.DB.prepare(
    "INSERT INTO webhook_outbox (trigger_action, target_url, payload, signature) VALUES (?, ?, ?, ?) RETURNING id"
  ).bind(triggerAction, target, payload, signature).first<{ id: number }>();

  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Signature": signature, "User-Agent": "team11-campus-parking-webhook/1.0" },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    const text = (await res.text()).slice(0, 2000);
    await env.DB.prepare("UPDATE webhook_outbox SET response_status = ?, response_body = ?, completed_at = ? WHERE id = ?")
      .bind(res.status, text, nowIso(), row?.id ?? 0).run();
  } catch (err) {
    await env.DB.prepare("UPDATE webhook_outbox SET error = ?, completed_at = ? WHERE id = ?")
      .bind(String(err instanceof Error ? err.message : err), nowIso(), row?.id ?? 0).run();
  }
}

// --- 1. + 6. Consumer with graceful degradation. Timeout-guarded partner call;
// on failure serve the last good snapshot, mark the response degraded, and log
// a 'recovered' row on the first success after a failure.
app.get("/integration/partner/zones", async (c) => {
  const base = c.env.PARTNER_BASE_URL;
  const path = c.env.PARTNER_ZONES_PATH ?? "/api/zones";
  if (!base) return c.json({ error: "PARTNER_BASE_URL is not configured" }, 500);
  const partnerUrl = base.replace(/\/$/, "") + path;
  const requestedAt = nowIso();
  const started = Date.now();

  const previous = await c.env.DB.prepare("SELECT outcome FROM integration_log ORDER BY id DESC LIMIT 1").first<{ outcome: string }>();
  const wasDown = previous?.outcome === "degraded";

  try {
    if (c.env.PARTNER_SIMULATE_DOWN === "true") throw new Error("simulated partner outage (PARTNER_SIMULATE_DOWN=true)");
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "team11-campus-parking-consumer/1.0" };
    if (c.env.PARTNER_API_KEY) headers.Authorization = `ApiKey ${c.env.PARTNER_API_KEY}`;
    const res = await fetch(partnerUrl, { headers, signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`partner responded ${res.status}: ${text.slice(0, 200)}`);
    const latency = Date.now() - started;
    const outcome = wasDown ? "recovered" : "ok";

    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO partner_cache (cache_key, body, fetched_at) VALUES ('zones', ?, ?) ON CONFLICT(cache_key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at").bind(text, requestedAt),
      c.env.DB.prepare("INSERT INTO integration_log (partner_url, outcome, http_status, latency_ms) VALUES (?, ?, ?, ?)").bind(partnerUrl, outcome, res.status, latency),
    ]);
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* partner returned non-JSON; pass through */ }
    return c.json({ degraded: false, source: "partner", partner_url: partnerUrl, requested_at: requestedAt, latency_ms: latency, recovered: wasDown, data });
  } catch (err) {
    const latency = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const cached = await c.env.DB.prepare("SELECT body, fetched_at FROM partner_cache WHERE cache_key = 'zones'").first<{ body: string; fetched_at: string }>();
    await c.env.DB.prepare("INSERT INTO integration_log (partner_url, outcome, latency_ms, error) VALUES (?, 'degraded', ?, ?)").bind(partnerUrl, latency, message).run();

    let data: unknown = null;
    if (cached) { try { data = JSON.parse(cached.body); } catch { data = cached.body; } }
    // 200, not 5xx: the caller still gets a usable answer, clearly labelled.
    return c.json({
      degraded: true,
      source: cached ? "cache" : "none",
      partner_url: partnerUrl,
      requested_at: requestedAt,
      partner_error: message,
      cache_fetched_at: cached?.fetched_at ?? null,
      data,
    });
  }
});

app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
